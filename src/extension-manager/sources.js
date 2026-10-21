import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { createGitHttpClient } from './builtin-http.js';
import { getCloudMirrors } from './cloud-mirrors.js';
import { classifyGitFailure, ExtensionOpError } from './errors.js';
import { runGit } from './git-runner.js';
import { getManagerRoot } from './paths.js';
import { hostLabel, toGithubUrl } from './remote-url.js';
import { anySignal, redactUrl } from './util.js';

const ROUTE_TTL_MS = 30 * 60_000;
const FAILURE_PENALTY_MS = 2 * 60_000;
const INITIAL_BATCH = 6;
const ESCALATE_MS = 2500;
const GRACE_MS = 1500;
const DISCOVERY_WAIT_MS = 15000;
const SAVE_DELAY_MS = 2000;
// ssh、file:// 和本机绝对路径(自己开发的扩展常见)只能原样交给系统 git
const NON_HTTP_REMOTE = /^(ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:|^[a-z]:[\\/]|^\//i;

// cacheHost -> Map(routeId -> { okAt, failAt, latencyMs })
const routeStats = new Map();
// cacheHost -> 正在进行的线路探测;同一个站点的版本检查排队等第一个探测结果,不要一起把所有线路试一遍
const discoveries = new Map();
let saveTimer = null;

/**
 * 根据远端地址生成候选线路。
 * GitHub 仓库(包括用镜像地址装的):直连 + 每个可用代理 + 前缀镜像 + 域名镜像;
 * 其它 http 仓库:直连 + 代理;带账号密码的地址不发给镜像;ssh、本地路径只能原样走系统 git。
 */
export function buildRoutes(remote, { config, proxies = [] }) {
    const routes = [];
    const add = route => {
        if (!routes.some(item => item.id === route.id)) {
            routes.push({ proxy: '', ...route, priority: routes.length });
        }
    };

    if (!remote.isHttp) {
        if (NON_HTTP_REMOTE.test(remote.raw)) {
            add({ id: 'origin', kind: 'direct', label: '原地址', url: remote.raw, authoritative: true, sshLike: true });
        }
        return routes;
    }

    const useCanonical = remote.github && !remote.hasCredentials;
    const primaryUrl = useCanonical ? remote.canonical : remote.raw;
    add({ id: 'direct', kind: 'direct', label: remote.github ? '直连 GitHub' : `直连 ${remote.host}`, url: primaryUrl, authoritative: true });
    for (const proxy of proxies) {
        add({ id: `proxy:${proxy.url}`, kind: 'proxy', label: `代理 ${hostLabel(proxy.url)}`, url: primaryUrl, proxy: proxy.url, authoritative: true });
    }
    if (useCanonical) {
        buildMirrorRoutes(remote, config, '镜像').forEach(add);
        if (remote.mirror) {
            // 当初安装用的镜像不在列表里时也试一下
            const id = remote.mirror.kind === 'prefix' ? `mirror:${remote.mirror.base}` : `domain:${remote.mirror.host}`;
            add({
                id,
                kind: 'mirror',
                label: `原镜像 ${remote.host}`,
                url: remote.raw,
                authoritative: false,
                prefix: remote.mirror.kind === 'prefix' ? remote.mirror.base : undefined,
            });
        }
    }
    return routes;
}

function buildMirrorRoutes(remote, { prefixMirrors = [], domainMirrors = [] }, labelPrefix) {
    const githubUrl = toGithubUrl(remote.github, { forceGitSuffix: true });
    return [
        ...prefixMirrors.map(prefix => ({ id: `mirror:${prefix}`, kind: 'mirror', label: `${labelPrefix} ${hostLabel(prefix)}`, url: `${prefix}${githubUrl}`, authoritative: false, prefix })),
        ...domainMirrors.map(host => ({ id: `domain:${host}`, kind: 'mirror', label: `${labelPrefix} ${host}`, url: `https://${host}/${remote.github.owner}/${remote.github.repo}.git`, authoritative: false })),
    ];
}

export function parseLsRemote(stdout) {
    const symrefs = new Map();
    const refs = new Map();
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
        const symref = /^ref:\s+(\S+)\t(\S+)$/.exec(line);
        if (symref) {
            symrefs.set(symref[2], symref[1]);
            continue;
        }
        const ref = /^([0-9a-f]{40,64})\t(\S+)$/.exec(line);
        if (ref) {
            refs.set(ref[2], ref[1]);
        }
    }
    return { symrefs, refs };
}

export function summarizeRefs({ symrefs, refs }, branch) {
    const headTarget = symrefs.get('HEAD') ?? null;
    const defaultBranch = headTarget?.startsWith('refs/heads/') ? headTarget.slice('refs/heads/'.length) : null;
    return {
        defaultBranch,
        defaultSha: refs.get('HEAD') ?? (headTarget ? refs.get(headTarget) : null) ?? null,
        branch: branch || null,
        branchSha: branch ? refs.get(`refs/heads/${branch}`) ?? null : null,
    };
}

export async function probeRoute(route, { backend, branch, timeoutMs, gitProxyKeys = [], signal }) {
    const started = Date.now();
    const base = { route, ok: false, latencyMs: 0, refs: null, failure: null };
    try {
        const refs = backend === 'builtin' && !route.sshLike
            ? await probeBuiltin(route, { branch, timeoutMs, signal })
            : await probeSystem(route, { branch, timeoutMs, gitProxyKeys, signal });
        return { ...base, ok: true, latencyMs: Date.now() - started, refs };
    } catch (error) {
        return {
            ...base,
            latencyMs: Date.now() - started,
            failure: error?.failure ?? classifyBuiltinError(error, { aborted: signal?.aborted }),
        };
    }
}

async function probeSystem(route, { branch, timeoutMs, gitProxyKeys, signal }) {
    const args = ['ls-remote', '--symref', '--', route.url, 'HEAD'];
    if (branch) {
        args.push(`refs/heads/${branch}`);
    }
    const result = await runGit(args, { cwd: os.tmpdir(), timeoutMs, network: route, gitProxyKeys, signal });
    if (result.code !== 0) {
        throw Object.assign(new Error('ls-remote failed'), { failure: classifyGitFailure(result.stderr, result) });
    }
    return summarizeRefs(parseLsRemote(result.stdout), branch);
}

async function probeBuiltin(route, { branch, timeoutMs, signal }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const client = createGitHttpClient({ proxy: route.proxy, signal: anySignal([signal, timeout]) });
    try {
        const list = await git.listServerRefs({ http: client, url: route.url, protocolVersion: 1, symrefs: true });
        const symrefs = new Map();
        const refs = new Map();
        for (const item of list) {
            refs.set(item.ref, item.oid);
            if (item.target) symrefs.set(item.ref, item.target);
        }
        return summarizeRefs({ symrefs, refs }, branch);
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
            failure: classifyBuiltinError(error, { timedOut: timeout.aborted, aborted: signal?.aborted }),
        });
    } finally {
        client.destroy();
    }
}

export function classifyBuiltinError(error, { timedOut = false, aborted = false } = {}) {
    const status = error?.data?.statusCode;
    const text = [error?.code, error?.message, status ? `returned error: ${status}` : '', error?.cause?.message]
        .filter(Boolean)
        .join('\n');
    return classifyGitFailure(text, { timedOut, aborted });
}

/**
 * 并发探测线路:先发一批,2.5 秒内没有成功再把剩下的全发出去;有一条成功后不再发新的。
 * 直连/代理(权威线路)一成功立即结束;只有镜像成功时再等 1.5 秒,看看能不能等到权威结果或更多镜像互相印证。
 */
export function probeRoutes(routes, options) {
    const {
        backend,
        branch,
        config,
        gitProxyKeys,
        signal,
        purpose = 'update',
        cacheHost = '',
        exhaustive = false,
        initialBatch = INITIAL_BATCH,
        onResult,
    } = options;

    return new Promise(resolve => {
        const results = [];
        const controllers = new Set();
        let pending = 0;
        let next = 0;
        let firstSuccessAt = 0;
        let finished = false;
        let escalateTimer = null;
        let graceTimer = null;

        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(escalateTimer);
            clearTimeout(graceTimer);
            signal?.removeEventListener('abort', finish);
            for (const controller of controllers) controller.abort();
            resolve(results);
        };

        const launch = route => {
            const controller = new AbortController();
            controllers.add(controller);
            pending++;
            void probeRoute(route, {
                backend,
                branch,
                timeoutMs: config.probeTimeoutMs,
                gitProxyKeys,
                signal: anySignal([signal, controller.signal]),
            }).then(result => {
                controllers.delete(controller);
                pending--;
                if (finished) return;
                results.push(result);
                recordRouteResult(cacheHost, result);
                try {
                    onResult?.(result);
                } catch {
                    // 只是用来记日志
                }
                evaluate();
            });
        };

        const launchUpTo = count => {
            let remaining = count;
            while (next < routes.length && remaining-- > 0) {
                launch(routes[next++]);
            }
        };

        const evaluate = () => {
            const okResults = results.filter(result => result.ok);
            if (!exhaustive && okResults.length > 0) {
                if (okResults.some(result => result.route.authoritative)) {
                    finish();
                    return;
                }
                if (!firstSuccessAt) {
                    firstSuccessAt = Date.now();
                    const grace = purpose === 'version' ? 0 : GRACE_MS;
                    if (grace === 0) {
                        finish();
                        return;
                    }
                    graceTimer = setTimeout(finish, grace);
                }
            }
            if (pending === 0) {
                if (!firstSuccessAt && next < routes.length) {
                    launchUpTo(routes.length);
                    return;
                }
                finish();
            }
        };

        if (signal?.aborted || routes.length === 0) {
            finish();
            return;
        }
        signal?.addEventListener('abort', finish, { once: true });
        launchUpTo(exhaustive ? routes.length : Math.max(1, initialBatch));
        if (next < routes.length) {
            escalateTimer = setTimeout(() => {
                if (!firstSuccessAt && !finished) launchUpTo(routes.length);
            }, ESCALATE_MS);
        }
    });
}

/**
 * 根据各线路的结果确定远端版本。
 * 有直连/代理结果时以它为准(那就是 GitHub 本身);只有镜像时按多数决,
 * 平票时优先"分支存在"、再优先"和本地一致"(宁可不更新,也不要被落后的镜像带着降级)。
 */
export function decideRemote(results, { branch = null, localHead = null } = {}) {
    const okResults = results.filter(result => result.ok);
    if (okResults.length === 0) {
        return null;
    }
    const shaOf = result => (branch ? result.refs.branchSha : result.refs.defaultSha) ?? null;
    const authoritative = okResults.filter(result => result.route.authoritative).sort((a, b) => a.latencyMs - b.latencyMs);

    let chosen;
    if (authoritative.length > 0) {
        chosen = shaOf(authoritative[0]);
    } else {
        const groups = new Map();
        for (const result of okResults) {
            const key = shaOf(result) ?? '';
            groups.set(key, [...(groups.get(key) ?? []), result]);
        }
        const bestPriority = list => Math.min(...list.map(result => result.route.priority ?? 0));
        const ranked = [...groups.entries()].sort(([shaA, listA], [shaB, listB]) =>
            listB.length - listA.length
            || Number(Boolean(shaB)) - Number(Boolean(shaA))
            || Number(Boolean(localHead) && shaB === localHead) - Number(Boolean(localHead) && shaA === localHead)
            || bestPriority(listA) - bestPriority(listB));
        chosen = ranked[0][0] || null;
    }

    const agreeing = okResults.filter(result => shaOf(result) === chosen).sort((a, b) => a.latencyMs - b.latencyMs);
    const disagreeing = okResults.filter(result => shaOf(result) !== chosen);
    // 默认分支信息也以权威线路为准,镜像可能还停在旧的默认分支上
    const reference = authoritative[0] ?? agreeing[0];
    return {
        sha: chosen,
        branchFound: Boolean(chosen),
        defaultBranch: reference.refs.defaultBranch,
        defaultSha: reference.refs.defaultSha,
        authoritative: authoritative.length > 0,
        agreeing,
        disagreeing,
    };
}

/**
 * 完整的远端检查:按历史表现排序线路 → (版本检查)先试上次最快的线路 → 并发探测 → 决定远端版本。
 */
export async function checkRemote({ remote, branch = null, purpose, backend, config, proxyInfo, localHead = null, signal, exhaustive = false, includeCloud = false, onResult }) {
    const routes = buildRoutes(remote, { config, proxies: proxyInfo?.alive ?? [] });
    if (routes.length === 0) {
        throw new ExtensionOpError('UNSUPPORTED_REMOTE', `不支持这种远端地址:${remote.display || '(空)'}`, { status: 400, stage: 'probe' });
    }
    const cacheHost = remote.cacheHost || remote.host || 'other';
    const probeOptions = { backend, branch, config, gitProxyKeys: proxyInfo?.gitProxyKeys ?? [], signal, purpose, cacheHost, onResult };

    if (!exhaustive && !getFreshBest(cacheHost, routes) && discoveries.has(cacheHost)) {
        await waitForDiscovery(discoveries.get(cacheHost), signal);
    }

    const ranked = exhaustive ? routes : rankRoutes(routes, cacheHost);
    const best = exhaustive ? null : getFreshBest(cacheHost, ranked);
    const results = [];

    if (purpose === 'version' && best) {
        const result = await probeRoute(best, {
            backend,
            branch,
            timeoutMs: config.probeTimeoutMs,
            gitProxyKeys: probeOptions.gitProxyKeys,
            signal,
        });
        if (!signal?.aborted) {
            recordRouteResult(cacheHost, result);
            onResult?.(result);
        }
        results.push(result);
        if (result.ok) {
            return { routes: ranked, results, decision: decideRemote(results, { branch, localHead }), cacheHost };
        }
    }

    const remaining = ranked.filter(route => !results.some(result => result.route.id === route.id));
    // 有上次的最快线路时先少发几条(权威线路只发它自己);版本检查走到这里说明最快线路刚失败,按正常批量发
    const fastPathFailed = results.length > 0;
    const initialBatch = exhaustive
        ? remaining.length
        : best && !fastPathFailed ? (best.authoritative ? 1 : 3) : INITIAL_BATCH;
    const probing = probeRoutes(remaining, { ...probeOptions, exhaustive, initialBatch });
    if (!best && !exhaustive && !discoveries.has(cacheHost)) {
        discoveries.set(cacheHost, probing);
        probing.finally(() => {
            if (discoveries.get(cacheHost) === probing) discoveries.delete(cacheHost);
        });
    }
    results.push(...await probing);
    const check = { routes: ranked, results, decision: decideRemote(results, { branch, localHead }), cacheHost, cloud: null };
    // 内置线路全部连不上时再读云端镜像列表试一轮;手动测试线路时总是一起测,方便确认云端列表能用
    if ((includeCloud || !results.some(result => result.ok)) && !signal?.aborted) {
        await addCloudMirrorRoutes(check, remote, { ...probeOptions, exhaustive, localHead, force: includeCloud });
    }
    return check;
}

async function addCloudMirrorRoutes(check, remote, { exhaustive, localHead, force, ...probeOptions }) {
    if (!remote.github || remote.hasCredentials) {
        return;
    }
    const list = await getCloudMirrors({ force });
    if (!list) {
        return;
    }
    const known = new Set(check.routes.map(route => route.id));
    const routes = buildMirrorRoutes(remote, list, '云端镜像')
        .filter(route => !known.has(route.id))
        .map((route, index) => ({ proxy: '', ...route, priority: check.routes.length + index }));
    check.cloud = { ok: list.ok, error: list.error, total: list.prefixMirrors.length + list.domainMirrors.length, added: routes.length };
    if (!routes.length || probeOptions.signal?.aborted) {
        return;
    }
    const results = await probeRoutes(routes, { ...probeOptions, exhaustive, initialBatch: routes.length });
    check.routes = [...check.routes, ...routes];
    check.results = [...check.results, ...results];
    check.decision = decideRemote(check.results, { branch: probeOptions.branch, localHead });
}

function waitForDiscovery(promise, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, DISCOVERY_WAIT_MS);
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        signal?.addEventListener('abort', done, { once: true });
        promise.then(done, done);
    });
}

/**
 * 获取阶段的线路顺序:先是和最终版本一致的线路(按延迟),再是还没试过的线路;探测失败或给出不同版本的排除。
 */
export function orderFetchRoutes(check) {
    const { routes, results, decision } = check;
    const agreeing = decision?.agreeing.map(result => result.route) ?? [];
    const tried = new Set(results.map(result => result.route.id));
    const untried = routes.filter(route => !tried.has(route.id));
    return [...agreeing, ...untried];
}

export function rankRoutes(routes, cacheHost) {
    const stats = routeStats.get(cacheHost);
    const now = Date.now();
    return routes
        .map((route, index) => {
            const stat = stats?.get(route.id);
            const recentOk = Boolean(stat?.okAt && now - stat.okAt < ROUTE_TTL_MS && !(stat.failAt > stat.okAt));
            const recentFail = Boolean(stat?.failAt && now - stat.failAt < FAILURE_PENALTY_MS && !(stat.okAt > stat.failAt));
            return { route, index, group: recentOk ? 0 : recentFail ? 2 : 1, latency: recentOk ? stat.latencyMs : Infinity };
        })
        .sort((a, b) => a.group - b.group || (a.group === 0 ? a.latency - b.latency : 0) || a.index - b.index)
        .map(item => item.route);
}

function getFreshBest(cacheHost, routes) {
    const stats = routeStats.get(cacheHost);
    if (!stats) return null;
    const now = Date.now();
    let best = null;
    let bestLatency = Infinity;
    for (const route of routes) {
        const stat = stats.get(route.id);
        if (stat?.okAt && now - stat.okAt < ROUTE_TTL_MS && !(stat.failAt > stat.okAt) && stat.latencyMs < bestLatency) {
            best = route;
            bestLatency = stat.latencyMs;
        }
    }
    return best;
}

export function recordRouteResult(cacheHost, result) {
    if (!cacheHost || result.failure?.kind === 'aborted') {
        return;
    }
    const stats = routeStats.get(cacheHost) ?? new Map();
    routeStats.set(cacheHost, stats);
    const stat = stats.get(result.route.id) ?? { okAt: 0, failAt: 0, latencyMs: 0 };
    if (result.ok) {
        stat.okAt = Date.now();
        // 平滑一下,避免一次偶然的慢请求把最快的线路挤掉
        stat.latencyMs = stat.latencyMs ? Math.round(stat.latencyMs * 0.5 + result.latencyMs * 0.5) : result.latencyMs;
    } else {
        stat.failAt = Date.now();
    }
    stats.set(result.route.id, stat);
    scheduleSave();
}

export function getRouteStatsSnapshot() {
    const now = Date.now();
    const hosts = {};
    for (const [host, stats] of routeStats) {
        hosts[host] = [...stats.entries()].map(([id, stat]) => ({
            id: redactUrl(id),
            ok: Boolean(stat.okAt && now - stat.okAt < ROUTE_TTL_MS && !(stat.failAt > stat.okAt)),
            latencyMs: stat.latencyMs,
            okAt: stat.okAt || null,
            failAt: stat.failAt || null,
        })).sort((a, b) => Number(b.ok) - Number(a.ok) || a.latencyMs - b.latencyMs);
    }
    return hosts;
}

function getStatsFile() {
    return path.join(getManagerRoot(), 'routes.json');
}

export function loadRouteStats() {
    try {
        const data = JSON.parse(fs.readFileSync(getStatsFile(), 'utf8'));
        for (const [host, entries] of Object.entries(data?.hosts ?? {})) {
            const stats = new Map();
            for (const [id, stat] of Object.entries(entries ?? {})) {
                stats.set(id, { okAt: Number(stat.okAt) || 0, failAt: Number(stat.failAt) || 0, latencyMs: Number(stat.latencyMs) || 0 });
            }
            routeStats.set(host, stats);
        }
    } catch {
        // 第一次运行或文件损坏都从空白开始
    }
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveRouteStats();
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
}

export function saveRouteStats() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const hosts = {};
    for (const [host, stats] of routeStats) {
        hosts[host] = Object.fromEntries(stats);
    }
    try {
        const file = getStatsFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomicSync(file, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`);
    } catch (error) {
        console.warn('[BaiBaoKu] 线路记录保存失败:', error?.message ?? error);
    }
}

export function resetRouteStats() {
    routeStats.clear();
    discoveries.clear();
}
