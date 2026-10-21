// 柏宝库自更新:index.js 在加载主代码之前调用。只能 import Node 内置模块和酒馆自己的模块(原因见 index.js)。
//
// 酒馆启动时会先对 plugins 下每个 git 仓库 fetch + pull,直连远端、没有超时,连不上 GitHub 就卡在那里。
// 所以这里把当前分支的上游改成本地的 origin/<分支>:酒馆那一步只合并已经下载好的提交,不再联网;
// 检查和下载由柏宝库自己做,带超时,并在直连、代理、镜像之间挑能用的线路。
// 原来的上游记在 baibaoku.upstream.*;关闭自更新(git config baibaoku.selfUpdate false,
// 或酒馆 config.yaml 的 enableServerPluginsAutoUpdate: false)时恢复。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getConfigValue } from '../../src/util.js';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_SECTION = 'baibaoku.upstream';
const PROBE_TIMEOUT_MS = 5000;
const DOWNLOAD_WAIT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 15_000;
const MAX_ROUTES = 5;
// 扩展管理测出来的线路(routes.json)优先,这两个只是兜底,取自 src/extension-manager/config.js 的默认镜像
const FALLBACK_MIRRORS = ['https://gh-proxy.org/', 'https://ghfast.top/'];
const PROXY_ENV_KEYS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];

/**
 * 检查并更新柏宝库自己,永远不 throw,返回 { status }。
 * 有新版本时下载并快进合并;下载超过 downloadWaitMs 就先返回,下载在后台继续,下次启动时由酒馆合并。
 * 参数只给测试用。
 */
export async function runSelfUpdate(options = {}) {
    try {
        return await selfUpdate({ root: PLUGIN_ROOT, probeTimeoutMs: PROBE_TIMEOUT_MS, downloadWaitMs: DOWNLOAD_WAIT_MS, ...options });
    } catch (error) {
        console.warn('[BaiBaoKu] 自动更新出错,先用当前版本启动:', error?.message ?? error);
        return { status: 'error', error };
    }
}

async function selfUpdate({ root, autoUpdate = readStAutoUpdate(), dataRoot = globalThis.DATA_ROOT, probeTimeoutMs, downloadWaitMs }) {
    // 和酒馆一样只管仓库根目录;解压安装的没有 .git,再往上找就是酒馆自己的仓库了
    if (!fs.existsSync(path.join(root, '.git'))) {
        return { status: 'not-repo' };
    }
    const listed = await git(root, ['config', '--list', '-z']);
    if (listed.code !== 0) {
        return { status: 'git-unavailable' };
    }
    const config = parseConfigList(listed.stdout);
    const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
    const enabled = autoUpdate && !isFalse(config['baibaoku.selfupdate']);
    const record = readUpstreamRecord(config);

    if (record && (!enabled || record.branch !== branch)) {
        await releaseUpstream(root, config, record);
    }
    if (!enabled || !branch) {
        return { status: enabled ? 'detached' : 'disabled' };
    }

    const upstream = await claimUpstream(root, config, branch, record?.branch === branch ? record : null);
    if (!upstream) {
        return { status: 'no-upstream' };
    }
    const remoteBranch = upstream.merge.slice('refs/heads/'.length);
    const routes = buildSelfUpdateRoutes(config[`remote.${upstream.remote}.url`], {
        routeStats: readRouteStats(dataRoot),
        configuredProxy: hasConfiguredProxy(config),
    });
    if (routes.length === 0) {
        return { status: 'no-remote' };
    }

    const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const latest = await probeLatest(root, routes, remoteBranch, probeTimeoutMs);
    if (!latest) {
        console.info('[BaiBaoKu] 检查更新失败(线路都连不上),先用当前版本启动。');
        return { status: 'unreachable' };
    }
    if (latest.sha === head || await gitOk(root, ['merge-base', '--is-ancestor', latest.sha, head])) {
        return { status: 'up-to-date' };
    }

    if (!await gitOk(root, ['cat-file', '-e', `${latest.sha}^{commit}`])) {
        const download = startGit(root, ['fetch', '--no-tags', '--', latest.route.url, `+refs/heads/${remoteBranch}:${upstream.tracking}`], {
            route: latest.route,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });
        const fetched = await waitAtMost(download.done, downloadWaitMs);
        if (!fetched) {
            console.info('[BaiBaoKu] 发现新版本,还没下载完,先用当前版本启动;下载在后台继续,下次启动酒馆时生效。');
            const pending = download.done.then(result => {
                if (result.code === 0) {
                    console.info('[BaiBaoKu] 新版本已在后台下载好,下次启动酒馆时生效。');
                } else {
                    console.warn('[BaiBaoKu] 后台下载新版本失败:', lastLine(result.stderr));
                }
                return result;
            });
            return { status: 'downloading', pending };
        }
        if (fetched.code !== 0) {
            console.warn(`[BaiBaoKu] 下载新版本失败(${latest.route.label}):`, lastLine(fetched.stderr));
            return { status: 'download-failed' };
        }
    }

    const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code !== 0 || dirty.stdout.trim()) {
        console.info('[BaiBaoKu] 发现新版本,但柏宝库目录里有本地修改,跳过自动更新。');
        return { status: 'dirty' };
    }
    const before = readPackage(root);
    const merged = await git(root, ['merge', '--ff-only', '--quiet', latest.sha]);
    if (merged.code !== 0) {
        console.warn('[BaiBaoKu] 自动更新失败:', lastLine(merged.stderr));
        return { status: 'merge-failed' };
    }
    const after = readPackage(root);
    console.info(`[BaiBaoKu] 已自动更新:${before.version ?? head.slice(0, 7)} → ${after.version ?? latest.sha.slice(0, 7)}(${latest.route.label})`);
    if (JSON.stringify([before.dependencies, before.optionalDependencies]) !== JSON.stringify([after.dependencies, after.optionalDependencies])) {
        console.warn('[BaiBaoKu] 新版本的依赖有变化,请在柏宝库目录运行 npm install --omit=dev 后重启酒馆。');
    }
    return { status: 'updated', from: head, to: latest.sha };
}

// 把当前分支的上游改成本地的远端跟踪分支(如 origin/main);分支没有远端上游时返回 null
async function claimUpstream(root, config, branch, record) {
    const merge = config[`branch.${branch}.merge`] ?? '';
    if (record && merge.startsWith('refs/remotes/')) {
        if (config[`branch.${branch}.remote`] !== '.') {
            // 上次改到一半被打断
            await setConfig(root, `branch.${branch}.remote`, '.');
        }
        return { ...record, tracking: merge };
    }

    // 第一次运行,或者用户自己改过上游
    const remote = config[`branch.${branch}.remote`];
    if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) {
        return null;
    }
    const tracking = (await git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
    if (!tracking.startsWith('refs/remotes/')) {
        return null;
    }
    const pushRemote = !config[`branch.${branch}.pushremote`] && !config['remote.pushdefault'];
    // 先记下原来的上游,改到一半被打断也能恢复
    await setConfig(root, `${UPSTREAM_SECTION}.branch`, branch);
    await setConfig(root, `${UPSTREAM_SECTION}.remote`, remote);
    await setConfig(root, `${UPSTREAM_SECTION}.merge`, merge);
    await setConfig(root, `${UPSTREAM_SECTION}.pushRemote`, String(pushRemote));
    if (pushRemote) {
        // 上游是本地以后 git push 默认会推给 ".",让它照旧推到原来的远端
        await setConfig(root, `branch.${branch}.pushRemote`, remote);
    }
    await setConfig(root, `branch.${branch}.merge`, tracking);
    await setConfig(root, `branch.${branch}.remote`, '.');
    console.info(`[BaiBaoKu] 已把 ${branch} 分支的上游改成本地的 ${tracking.slice('refs/remotes/'.length)}:酒馆启动时不再直连远端,由柏宝库自己挑线路更新。自己开发的目录可以运行 git config baibaoku.selfUpdate false 关掉。`);
    return { branch, remote, merge, tracking };
}

async function releaseUpstream(root, config, { branch, remote, merge, pushRemote }) {
    // 上游已经不是我们改的样子(用户自己改过或删了分支)就只删记录
    if ((config[`branch.${branch}.merge`] ?? '').startsWith('refs/remotes/')) {
        await setConfig(root, `branch.${branch}.remote`, remote);
        await setConfig(root, `branch.${branch}.merge`, merge);
        if (pushRemote) {
            await git(root, ['config', '--unset', `branch.${branch}.pushRemote`]);
        }
        console.info(`[BaiBaoKu] 已把 ${branch} 分支的上游恢复成 ${remote}。`);
    }
    await git(root, ['config', '--remove-section', UPSTREAM_SECTION]);
}

function readUpstreamRecord(config) {
    const record = {
        branch: config[`${UPSTREAM_SECTION}.branch`],
        remote: config[`${UPSTREAM_SECTION}.remote`],
        merge: config[`${UPSTREAM_SECTION}.merge`],
        pushRemote: config[`${UPSTREAM_SECTION}.pushremote`] === 'true',
    };
    return record.branch && record.remote && record.merge ? record : null;
}

/**
 * 候选线路:扩展管理最近测通的线路(按延迟)→ 原镜像 → 直连 → 默认镜像,最多 MAX_ROUTES 条。
 * 线路 id 沿用 src/extension-manager/sources.js 的 buildRoutes,这样能直接读它的 routes.json。
 */
export function buildSelfUpdateRoutes(remoteUrl, { routeStats = {}, configuredProxy = false } = {}) {
    const raw = String(remoteUrl ?? '').trim();
    let url = null;
    try {
        url = new URL(raw);
    } catch {
        // ssh 简写(git@host:repo)不是合法 URL
    }
    if (!url || !/^https?:$/.test(url.protocol)) {
        // ssh、本机路径只能原样交给 git
        return raw ? [{ id: 'origin', kind: 'system', label: '原地址', url: raw }] : [];
    }

    // 带账号密码的地址不发给镜像
    const github = url.username || url.password ? null : parseGithubRemote(url);
    const primary = github ? `https://github.com/${github.owner}/${github.repo}.git` : raw;
    const stats = routeStats[github ? 'github.com' : url.hostname.toLowerCase()] ?? {};
    const remembered = Object.entries(stats)
        .filter(([, stat]) => stat?.okAt && !(stat.failAt > stat.okAt))
        .sort(([, a], [, b]) => (Number(a.latencyMs) || 0) - (Number(b.latencyMs) || 0))
        .map(([id]) => id);
    const ids = [...remembered, github?.mirror, 'direct', ...(github ? FALLBACK_MIRRORS.map(prefix => `mirror:${prefix}`) : [])];

    const routes = configuredProxy ? [{ id: 'system', kind: 'system', label: '本机代理设置', url: raw }] : [];
    for (const id of new Set(ids.filter(Boolean))) {
        const route = toRoute(id, primary, github);
        if (route && routes.length < MAX_ROUTES) {
            routes.push({ id, ...route });
        }
    }
    return routes;
}

function toRoute(id, primary, github) {
    if (id === 'direct') {
        return { kind: 'direct', label: '直连', url: primary };
    }
    if (id.startsWith('proxy:')) {
        return { kind: 'proxy', label: `代理 ${hostOf(id.slice(6))}`, url: primary, proxy: id.slice(6) };
    }
    if (github && id.startsWith('mirror:')) {
        return { kind: 'mirror', label: `镜像 ${hostOf(id.slice(7))}`, url: `${id.slice(7)}${primary}` };
    }
    if (github && id.startsWith('domain:')) {
        return { kind: 'mirror', label: `镜像 ${id.slice(7)}`, url: `https://${id.slice(7)}/${github.owner}/${github.repo}.git` };
    }
    return null;
}

// 规则同 src/extension-manager/remote-url.js:github.com 地址,或"前缀镜像 + GitHub 地址"(安装脚本连不上 GitHub 时用 gh-proxy.org 克隆)
function parseGithubRemote(url) {
    let pathname = url.pathname;
    let mirror = null;
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
        const prefixed = /^\/+(?:https?:\/+)?(?:www\.)?github\.com(\/.*)$/i.exec(pathname);
        if (!prefixed) {
            return null;
        }
        pathname = prefixed[1];
        mirror = `mirror:${url.origin}/`;
    }
    const parts = pathname.split('/').filter(Boolean);
    return parts.length === 2 ? { owner: parts[0], repo: parts[1].replace(/\.git$/i, ''), mirror } : null;
}

// 所有线路同时 ls-remote,用最先答复的那条;都失败或超时返回 null
async function probeLatest(root, routes, branch, timeoutMs) {
    const pattern = new RegExp(`^([0-9a-f]{40,64})\\trefs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`, 'm');
    const probes = routes.map(route => ({ route, ...startGit(root, ['ls-remote', '--', route.url, `refs/heads/${branch}`], { route, timeoutMs }) }));
    try {
        return await Promise.any(probes.map(async ({ route, done }) => {
            const result = await done;
            const sha = result.code === 0 ? pattern.exec(result.stdout)?.[1] : null;
            if (!sha) {
                throw new Error(lastLine(result.stderr));
            }
            return { route, sha };
        }));
    } catch {
        return null;
    } finally {
        probes.forEach(probe => killTree(probe.child));
    }
}

// 参数和 src/extension-manager/git-runner.js 的 runGit 一致:禁止交互式登录;联网时显式指定代理(直连就清空)并限制低速连接
function startGit(root, args, { route = null, timeoutMs = LOCAL_TIMEOUT_MS } = {}) {
    const configArgs = ['-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'safe.directory=*'];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C', GIT_CEILING_DIRECTORIES: path.dirname(root) };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
        delete env[key];
    }
    if (route) {
        configArgs.push('-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', '-c', 'core.askPass=', '-c', 'protocol.ext.allow=never');
        env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes -o ConnectTimeout=15';
        // system 线路照用户自己的代理设置走,和酒馆原来一样
        if (route.kind !== 'system') {
            configArgs.push('-c', `http.proxy=${route.proxy ?? ''}`);
            PROXY_ENV_KEYS.forEach(key => delete env[key]);
        }
        if (route.kind === 'mirror') {
            configArgs.push('-c', 'credential.helper=');
        }
    }

    let child = null;
    const done = new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        try {
            child = spawn('git', [...configArgs, ...args], {
                cwd: root,
                env,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
            return;
        }
        const timer = setTimeout(() => killTree(child), timeoutMs);
        timer.unref?.();
        const finish = code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        };
        child.stdout.setEncoding('utf8').on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', chunk => {
            stderr = (stderr + chunk).slice(-4096);
        });
        child.on('error', error => {
            stderr += `\n${error?.message ?? error}`;
            finish(-1);
        });
        child.on('close', code => finish(code ?? -1));
    });
    return { child, done };
}

function git(root, args) {
    return startGit(root, args).done;
}

async function gitOk(root, args) {
    return (await git(root, args)).code === 0;
}

async function setConfig(root, key, value) {
    const result = await git(root, ['config', key, value]);
    if (result.code !== 0) {
        throw new Error(`git config ${key} 失败:${lastLine(result.stderr)}`);
    }
}

function killTree(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

function waitAtMost(promise, ms) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(resolve, ms, null);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// git config --list -z:每项是 "键\n值",只有键名的布尔项没有 "\n"
function parseConfigList(stdout) {
    const config = {};
    for (const entry of stdout.split('\0')) {
        const newline = entry.indexOf('\n');
        if (newline > 0) {
            config[entry.slice(0, newline)] = entry.slice(newline + 1);
        } else if (entry) {
            config[entry] = 'true';
        }
    }
    return config;
}

function isFalse(value) {
    return /^(false|no|off|0)$/i.test(String(value ?? '').trim());
}

// 用户给 git 或环境变量配了代理时多试一条"照原样"的线路,保证不比酒馆原来的更新差
function hasConfiguredProxy(config) {
    return Object.entries(config).some(([key, value]) => /^https?\.(.+\.)?proxy$/.test(key) && value)
        || PROXY_ENV_KEYS.some(key => !/^no_proxy$/i.test(key) && process.env[key]);
}

// 扩展管理的线路记录,路径同 src/extension-manager/sources.js 的 getStatsFile
function readRouteStats(dataRoot) {
    if (!dataRoot) {
        return {};
    }
    try {
        const file = path.join(path.resolve(dataRoot), '_baibaoku', 'extension-manager', 'routes.json');
        return JSON.parse(fs.readFileSync(file, 'utf8'))?.hosts ?? {};
    } catch {
        return {};
    }
}

// 和酒馆 plugin-loader 读同一个开关:关掉后酒馆不自动更新插件,柏宝库也不自己更新
function readStAutoUpdate() {
    try {
        return Boolean(getConfigValue('enableServerPluginsAutoUpdate', true, 'boolean'));
    } catch {
        return true;
    }
}

function readPackage(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
        return {};
    }
}

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function lastLine(text) {
    return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? '';
}
