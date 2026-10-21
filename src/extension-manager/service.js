import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';
import { DEFAULT_DOMAIN_MIRRORS, DEFAULT_LOCAL_PROXY_PORTS, DEFAULT_PREFIX_MIRRORS, loadConfig, saveConfig } from './config.js';
import { ExtensionOpError } from './errors.js';
import {
    backupDir,
    backupFiles,
    moveToTrash,
    pathExists,
    removeExtensionDir,
    removePath,
    renameWithRetry,
    restoreFiles,
    sweepManagerDirs,
    sweepStagingDir,
} from './fs-utils.js';
import { resolveGitBackend } from './git-runner.js';
import { getJob, listJobs, runJob } from './jobs.js';
import { getOp, listOps, loadOps, OpRecorder } from './oplog.js';
import {
    assertInside,
    getExtensionsBase,
    getGlobalExtensionsBase,
    getUserExtensionsBase,
    getUserHandle,
    isAdmin,
    listUserExtensionBases,
    makeLockKey,
    RESERVED_PREFIX,
    resolveExtensionTarget,
    STAGING_DIRNAME,
} from './paths.js';
import { describeProxy, detectProxies } from './proxy.js';
import { fetchRemoteManifest } from './remote-manifest.js';
import { parseRemoteUrl } from './remote-url.js';
import { builtinRepo } from './repo-builtin.js';
import { classifyFolder, cleanupLockFiles, clearInProgressState, getGitDir, getInProgressState, hasLocalCommitsInReflog, readManifest } from './repo-fs.js';
import { isSafeBranchName, systemRepo } from './repo-system.js';
import { checkRemote, getRouteStatsSnapshot, loadRouteStats, orderFetchRoutes, recordRouteResult } from './sources.js';
import { anySignal, delay, formatList, redactUrl, shortSha } from './util.js';

const DEFAULT_TEST_URL = 'https://github.com/SillyTavern/SillyTavern';
const FILE_LOCK_RETRIES = 3;
const MIN_STEP_MS = 5000;
const NETWORK_HINT = '检查服务器的网络后稍后重试;服务器上开着代理软件时,柏宝库一般会自动用上。';
const CONFIG_KEYS = ['interceptEnabled', 'proxy', 'autoDetectProxy', 'localProxyPorts', 'prefixMirrors', 'domainMirrors', 'probeTimeoutMs', 'operationTimeoutMs'];

let isomorphicGitVersion;

function domainMirrorsOf(config) {
    return [...new Set([...DEFAULT_DOMAIN_MIRRORS, ...config.domainMirrors])];
}

export async function getEnvironment({ forceProxyDetect = false } = {}) {
    const config = loadConfig();
    const git = await resolveGitBackend();
    const proxyInfo = await detectProxies(config, { force: forceProxyDetect });
    return {
        config,
        backend: git.backend,
        preferredBackend: git.preferred,
        gitVersion: git.systemGitVersion,
        adapter: git.backend === 'system' ? systemRepo : builtinRepo,
        proxyInfo,
    };
}

function getIsomorphicGitVersion() {
    if (isomorphicGitVersion !== undefined) return isomorphicGitVersion;
    isomorphicGitVersion = null;
    try {
        // package.json 不在 exports 里,从入口文件往上找
        let dir = path.dirname(fileURLToPath(import.meta.resolve('isomorphic-git')));
        for (let depth = 0; depth < 4; depth++) {
            const file = path.join(dir, 'package.json');
            if (fs.existsSync(file)) {
                const json = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (json.name === 'isomorphic-git') {
                    isomorphicGitVersion = json.version ?? null;
                    break;
                }
            }
            dir = path.dirname(dir);
        }
    } catch {
        isomorphicGitVersion = null;
    }
    return isomorphicGitVersion;
}

function formatDuration(ms) {
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

function stage(job, op, name, message) {
    job.update({ stage: name, message, progress: null });
    op.setStage(name);
}

function remainingMs(job) {
    return Math.max(MIN_STEP_MS, job.deadline - Date.now());
}

function abortError(job) {
    if (job.timedOut) {
        return new ExtensionOpError('TIMEOUT', `操作超时(超过 ${formatDuration(job.deadline - job.createdAt)})。`, {
            status: 504,
            stage: job.stage,
            hint: '网络太慢或线路不稳定,稍后重试。',
        });
    }
    return new ExtensionOpError('ABORTED', '操作被中断(酒馆正在关闭或插件重新加载)。', { status: 503, stage: job.stage });
}

function throwIfAborted(job) {
    if (job.signal.aborted) {
        throw abortError(job);
    }
}

function normalizeError(error, job) {
    if (error instanceof ExtensionOpError) {
        error.stage ??= job.stage;
        return error;
    }
    if (job.signal.aborted) {
        return abortError(job);
    }
    console.error('[BaiBaoKu] 扩展操作出错:', error);
    return new ExtensionOpError('INTERNAL_ERROR', `内部错误:${error?.message ?? error}`, { status: 500, stage: job.stage, cause: error });
}

function describeFailures(entries, limit = 4) {
    const failed = entries.filter(entry => entry.failure && entry.failure.kind !== 'aborted');
    return formatList(failed.map(entry => `${entry.route.label}(${entry.failure.summary})`), limit);
}

function unreachableError(check, action, remote) {
    const failed = check.results.filter(result => !result.ok);
    const authoritative = failed.filter(result => result.route.authoritative && result.failure?.kind !== 'aborted');
    if (authoritative.length > 0 && authoritative.every(result => result.failure.kind === 'auth' || result.failure.kind === 'not-found')) {
        return new ExtensionOpError('REPO_NOT_FOUND', `仓库不存在,或者是私有仓库:${remote.display}`, {
            status: 400,
            stage: 'probe',
            hint: '检查扩展地址有没有写错;私有仓库需要先在系统 git 里配置好登录凭据。',
        });
    }
    return new ExtensionOpError('NETWORK', `${action}失败,所有线路都连不上:${describeFailures(failed) || '没有可用的线路'}`, {
        status: 502,
        stage: 'probe',
        hint: NETWORK_HINT,
    });
}

function downloadError(failures, action) {
    return new ExtensionOpError('DOWNLOAD_FAILED', `${action}失败:${describeFailures(failures) || '没有可用的线路'}`, {
        status: 502,
        stage: 'download',
        hint: NETWORK_HINT,
    });
}

function notRepoError(folder, detail = '') {
    return new ExtensionOpError('NOT_A_REPO', `「${folder}」不是用 git 安装的,无法自动更新。`, {
        status: 409,
        stage: 'inspect',
        hint: '可以删除后用仓库地址重新安装。',
        details: detail ? { detail } : undefined,
    });
}

async function isContained(adapter, dir, sha, head) {
    if (!sha || !head) return false;
    if (sha === head) return true;
    return (await adapter.hasCommit(dir, sha)) && (await adapter.isAncestor(dir, sha, head)) === true;
}

async function removeBackup(root) {
    // 备份目录结构:<backups>/<时间-随机>/<扩展名>,整个时间目录一起删
    await removePath(path.dirname(root)).catch(() => {});
}

/**
 * 每个安装/更新/删除都在任务里跑:同一目录串行、相同请求合并、超时可中断,并留一条操作记录。
 */
async function runOperation({ req, env, target, clientId, source, kind, signature, remoteDisplay = '' }, perform) {
    const user = getUserHandle(req);
    const { promise } = runJob({
        key: makeLockKey(target.dir),
        signature,
        clientId,
        kind,
        user,
        extension: target.folder,
        timeoutMs: env.config.operationTimeoutMs,
    }, async job => {
        const op = new OpRecorder({ kind, user, extension: target.folder, global: target.global, backend: env.backend, gitVersion: env.gitVersion, source: remoteDisplay });
        op.setDetail('via', source);
        job.opId = op.id;
        try {
            const outcome = await perform(job, op);
            op.finish({ ok: true, message: outcome.summary ?? '', result: outcome.logResult ?? null, record: !outcome.skipLog });
            return { ...outcome, opId: op.id };
        } catch (rawError) {
            const error = normalizeError(rawError, job);
            error.opId = op.id;
            op.finish({ ok: false, code: error.code, message: error.message, hint: error.hint ?? null, result: { stage: error.stage ?? null, details: error.details ?? null } });
            throw error;
        }
    });
    return promise;
}

function resolveExistingTarget(req, body, { write }) {
    const target = resolveExtensionTarget(req, body, { write });
    if (!fs.existsSync(target.dir)) {
        throw new ExtensionOpError('NOT_FOUND', `扩展目录不存在:${target.dir}`, { status: 404, stage: 'validate' });
    }
    return target;
}

// ───────────────────────── 安装 ─────────────────────────

function prepareInstallTarget(req, body) {
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new ExtensionOpError('INVALID_URL', '扩展地址不正确,需要填写 git 仓库的 http/https 地址。', { status: 400, stage: 'validate' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ExtensionOpError('INVALID_URL', '扩展地址只支持 http 和 https。', { status: 400, stage: 'validate' });
    }
    const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';
    if (branch && !isSafeBranchName(branch)) {
        throw new ExtensionOpError('INVALID_BRANCH', `分支名不合法:${branch}`, { status: 400, stage: 'validate' });
    }
    const global = Boolean(body?.global);
    const base = getExtensionsBase(req, global);
    // 和原生接口一样用地址最后一段当目录名,镜像地址(https://镜像/https://github.com/作者/仓库)得到的也是仓库名
    const folder = sanitize(path.basename(parsed.pathname, '.git'));
    if (!folder || folder === '.' || folder === '..' || folder.toLowerCase().startsWith(RESERVED_PREFIX)) {
        throw new ExtensionOpError('INVALID_NAME', '无法从地址里确定扩展名称,请填写完整的仓库地址。', { status: 400, stage: 'validate' });
    }
    const dir = path.join(base, folder);
    assertInside(base, dir);
    return { url: parsed.href, branch, global, base, folder, dir };
}

export async function installExtension(req, body, { clientId = null, source = 'api' } = {}) {
    const target = prepareInstallTarget(req, body);
    const env = await getEnvironment();
    const remote = parseRemoteUrl(target.url, { domainMirrors: domainMirrorsOf(env.config) });
    return runOperation({
        req,
        env,
        target,
        clientId,
        source,
        kind: 'install',
        signature: `install|${target.url}|${target.branch}|${target.global}`,
        remoteDisplay: remote.display,
    }, (job, op) => performInstall({ req, env, job, op, target, remote }));
}

async function performInstall({ req, env, job, op, target, remote }) {
    const { base, folder, dir, branch } = target;
    const user = getUserHandle(req);
    const warnings = [];
    await fsp.mkdir(base, { recursive: true });

    stage(job, op, 'check-folder', '检查目标目录');
    const existing = await classifyFolder(dir);
    if (existing.exists) {
        if (!existing.residual) {
            throw alreadyInstalledError(folder);
        }
        await moveResidualAside(dir, folder, { op, warnings, user });
    }

    stage(job, op, 'probe', '正在选择下载线路');
    const check = await checkRemote({
        remote,
        branch: branch || null,
        purpose: 'install',
        backend: env.backend,
        config: env.config,
        proxyInfo: env.proxyInfo,
        signal: job.signal,
        onResult: result => op.addProbeResult(result),
    });
    throwIfAborted(job);
    const decision = check.decision;
    if (!decision) {
        throw unreachableError(check, '安装', remote);
    }
    if (branch && !decision.branchFound && decision.authoritative) {
        throw new ExtensionOpError('BRANCH_NOT_FOUND', `仓库里没有「${branch}」这个分支。`, { status: 400, stage: 'probe' });
    }
    op.setDetail('remoteCommit', decision.sha);

    const stagingRoot = path.join(base, STAGING_DIRNAME, job.id);
    const stagingDir = path.join(stagingRoot, folder);
    try {
        stage(job, op, 'download', '正在下载');
        const route = await cloneWithRoutes({ env, job, op, check, stagingDir, branch });

        stage(job, op, 'verify', '检查扩展文件');
        const manifestResult = await readManifest(stagingDir);
        if (!manifestResult.ok) {
            throw new ExtensionOpError('INVALID_MANIFEST', manifestResult.missing
                ? '这个仓库里没有 manifest.json,不是酒馆扩展。'
                : `扩展的 manifest.json 有问题:${manifestResult.error}`, { status: 400, stage: 'verify' });
        }
        // 用镜像地址安装时 origin 记成 GitHub 原地址;以后更新时再自动挑线路
        await env.adapter.setOrigin(stagingDir, remote.mirror ? remote.canonical : target.url);
        const commit = await env.adapter.readHead(stagingDir);
        if (decision.authoritative && decision.sha && commit && commit !== decision.sha && !route.authoritative) {
            warnings.push(`通过${route.label}下载的版本(${shortSha(commit)})不是 GitHub 上的最新版(${shortSha(decision.sha)}),镜像可能有缓存,过一会可以再检查更新。`);
        }

        stage(job, op, 'finalize', '安装到扩展目录');
        await placeStagedExtension(stagingDir, dir, folder, { op, warnings, user });
        warnings.push(...findDuplicateWarnings(req, target));

        const { version, author, display_name } = manifestResult.manifest;
        return {
            response: {
                version,
                author,
                display_name,
                extensionPath: dir,
                folderName: folder,
                baibaoku: { opId: op.id, route: route.label, commit, warnings },
            },
            summary: `已安装 ${shortSha(commit)}(${route.label})`,
            logResult: { commit, route: route.label, warnings },
        };
    } finally {
        await removePath(stagingRoot).catch(() => {});
        // 空的临时目录也删掉,免得酒馆加载扩展列表时提示"没有 manifest.json"
        await fsp.rmdir(path.join(base, STAGING_DIRNAME)).catch(() => {});
    }
}

function alreadyInstalledError(folder) {
    return new ExtensionOpError('ALREADY_EXISTS', `扩展「${folder}」已经安装过了。`, {
        status: 409,
        stage: 'check-folder',
        hint: '要重装请先删除它;要升级请用更新。',
    });
}

// 没有 manifest.json 的同名目录(上次装到一半中断等)酒馆不会列出,却会挡住安装:挪到回收区后继续
async function moveResidualAside(dir, folder, { op, warnings, user }) {
    const lockedError = cause => new ExtensionOpError('RESIDUAL_LOCKED', `「${folder}」目录里有上次没装完的残留文件,被占用无法移走。`, {
        status: 409,
        stage: 'check-folder',
        hint: `关闭可能占用它的程序(编辑器、资源管理器、杀毒软件)后重试,或手动删除:${dir}`,
        cause,
    });
    let trashed;
    try {
        trashed = await moveToTrash(dir, { reason: 'residual-before-install', extension: folder, user });
    } catch (error) {
        throw lockedError(error);
    }
    if (await pathExists(dir)) {
        throw lockedError();
    }
    op.setDetail('residualTrash', trashed.trashPath);
    warnings.push('发现上次没装完的残留目录,已自动移到回收区。');
}

async function cloneWithRoutes({ env, job, op, check, stagingDir, branch }) {
    const failures = [];
    for (const route of orderFetchRoutes(check)) {
        throwIfAborted(job);
        job.update({ message: `正在下载(${route.label})`, progress: null });
        await removePath(stagingDir).catch(() => {});
        await fsp.mkdir(path.dirname(stagingDir), { recursive: true });
        const result = await env.adapter.clone(route, stagingDir, {
            branch: branch || null,
            signal: job.signal,
            onProgress: progress => job.update({ progress }),
            timeoutMs: remainingMs(job),
            gitProxyKeys: env.proxyInfo.gitProxyKeys,
        });
        op.addAttempt({ label: route.label, kind: route.kind, phase: 'clone', ok: result.ok, latencyMs: result.durationMs, error: result.ok ? null : result.failure });
        if (result.ok) {
            return route;
        }
        failures.push({ route, failure: result.failure });
        // 探测通过但下载失败的线路,接下来一段时间排到后面
        recordRouteResult(check.cacheHost, { route, ok: false, latencyMs: result.durationMs, failure: result.failure });
    }
    throwIfAborted(job);
    throw downloadError(failures, '下载扩展');
}

async function placeStagedExtension(stagingDir, dir, folder, { op, warnings, user }) {
    // 下载期间可能有人在同一位置放了东西
    const state = await classifyFolder(dir);
    if (state.exists) {
        if (!state.residual) {
            throw alreadyInstalledError(folder);
        }
        await moveResidualAside(dir, folder, { op, warnings, user });
    }
    try {
        await renameWithRetry(stagingDir, dir);
    } catch (error) {
        if ((await classifyFolder(dir)).hasManifest) {
            throw alreadyInstalledError(folder);
        }
        throw new ExtensionOpError('INSTALL_MOVE_FAILED', `下载完成,但移动到扩展目录失败:${error?.code ?? error?.message ?? error}`, {
            status: 500,
            stage: 'finalize',
            hint: '可能被杀毒软件或其它程序占用,稍后重新安装。',
            cause: error,
        });
    }
}

function findDuplicateWarnings(req, target) {
    try {
        if (target.global) {
            if (fs.existsSync(path.join(getUserExtensionsBase(req), target.folder, 'manifest.json'))) {
                return [`你的个人扩展里也有「${target.folder}」,对你来说酒馆会加载个人那份。`];
            }
        } else if (fs.existsSync(path.join(getGlobalExtensionsBase(), target.folder, 'manifest.json'))) {
            return [`全局扩展里也有「${target.folder}」,酒馆会优先加载你这份。`];
        }
    } catch {
        // 只是提示
    }
    return [];
}

// ───────────────────────── 更新 ─────────────────────────

export async function updateExtension(req, body, { clientId = null, source = 'api' } = {}) {
    const target = resolveExistingTarget(req, body, { write: true });
    const force = Boolean(body?.force);
    const env = await getEnvironment();
    return runOperation({
        req,
        env,
        target,
        clientId,
        source,
        kind: 'update',
        signature: `update|${force}`,
    }, (job, op) => performUpdate({ env, job, op, target, force }));
}

async function performUpdate({ env, job, op, target, force }) {
    const { adapter } = env;
    const { dir, folder } = target;
    const warnings = [];
    let backupPath = null;
    const ensureBackup = async () => {
        if (!backupPath) {
            job.update({ message: '正在备份扩展目录' });
            backupPath = await backupDir(dir, folder);
            op.setDetail('backupPath', backupPath);
        }
        return backupPath;
    };

    stage(job, op, 'inspect', '检查本地仓库');
    const gitDir = getGitDir(dir);
    if (!gitDir) {
        throw notRepoError(folder);
    }
    let info = await adapter.inspect(dir);
    if (!info.isRepo) {
        throw notRepoError(folder, info.detail);
    }
    if (!info.head) {
        throw new ExtensionOpError('EMPTY_REPO', `「${folder}」的仓库里还没有任何版本,无法更新。`, { status: 409, stage: 'inspect', hint: '删除后重新安装。' });
    }

    const locks = await cleanupLockFiles(gitDir, info.branch, { includeFresh: force });
    if (locks.removed.length) {
        op.setDetail('removedLocks', locks.removed);
    }
    if (locks.fresh.length) {
        throw new ExtensionOpError('LOCKED', `仓库正被其它 git 进程使用(${formatList(locks.fresh)})。`, {
            status: 409,
            stage: 'inspect',
            hint: '稍等一会再试;如果确定没有别的 git 在运行,可以用强制更新。',
        });
    }

    const pristine = !(await hasLocalCommitsInReflog(gitDir));
    op.setDetail('pristine', pristine);

    // 上次 git pull 冲突等留下的半截 merge/rebase:纯净安装直接撤销,有本地提交的要用户确认(强制更新)
    const progressState = await getInProgressState(gitDir);
    const inProgress = Object.entries(progressState).filter(([, active]) => active).map(([name]) => name);
    if (inProgress.length) {
        const names = inProgress.join('、');
        if (!pristine && !force) {
            throw new ExtensionOpError('IN_PROGRESS', `仓库里有没完成的 git 操作(${names})。`, {
                status: 409,
                stage: 'inspect',
                hint: '用 git 手动完成或撤销后再更新,或者用强制更新(会先备份整个目录)。',
            });
        }
        if (force) {
            await ensureBackup();
        }
        const aborted = await adapter.abortInProgress(dir, progressState);
        if (!aborted.ok) {
            if (!force) {
                throw new ExtensionOpError('IN_PROGRESS', `仓库里有没完成的 git 操作(${names}),自动撤销失败:${aborted.detail}`, {
                    status: 409,
                    stage: 'inspect',
                    hint: '可以用强制更新(会先备份整个目录)。',
                });
            }
            await clearInProgressState(gitDir);
        }
        op.setDetail('abortedInProgress', inProgress);
        warnings.push(`已撤销仓库里没完成的 git 操作(${names})。`);
        info = await adapter.inspect(dir);
        if (!info.isRepo || !info.head) {
            throw notRepoError(folder, info.detail);
        }
    }

    if (!info.remoteUrl) {
        throw new ExtensionOpError('NO_REMOTE', `「${folder}」没有配置远端地址(origin),不知道从哪里更新。`, {
            status: 409,
            stage: 'inspect',
            hint: '删除后用仓库地址重新安装。',
        });
    }
    const remote = parseRemoteUrl(info.remoteUrl, { domainMirrors: domainMirrorsOf(env.config) });
    op.setSource(remote.display);
    if (env.backend === 'builtin' && !remote.isHttp) {
        throw new ExtensionOpError('UNSUPPORTED_REMOTE', `内置 git 只支持 http/https 地址,这个扩展的远端是:${remote.display}`, {
            status: 409,
            stage: 'inspect',
            hint: '安装系统 git 后重试。',
        });
    }
    const trackedBranch = info.branch && info.upstream && isSafeBranchName(info.upstream) ? info.upstream : null;

    stage(job, op, 'probe', '正在检查远端版本');
    const check = await checkRemote({
        remote,
        branch: trackedBranch,
        purpose: 'update',
        backend: env.backend,
        config: env.config,
        proxyInfo: env.proxyInfo,
        localHead: info.head,
        signal: job.signal,
        onResult: result => op.addProbeResult(result),
    });
    throwIfAborted(job);
    const decision = check.decision;
    if (!decision) {
        throw unreachableError(check, '检查更新', remote);
    }
    op.setDetail('decision', { sha: decision.sha, authoritative: decision.authoritative, branchFound: decision.branchFound, defaultBranch: decision.defaultBranch });

    // 要对齐到哪个分支的哪个版本
    let fetchBranch = trackedBranch;
    let localBranch = info.branch;
    let switchTo = null;
    let switchNote = null;
    let targetSha = decision.sha;
    if (!trackedBranch || !decision.branchFound) {
        const defaultBranch = decision.defaultBranch;
        if (trackedBranch && !decision.authoritative) {
            throw new ExtensionOpError('BRANCH_GONE', `镜像上找不到「${trackedBranch}」分支,GitHub 直连又不可用,无法确认分支是否还在。`, {
                status: 502,
                stage: 'probe',
                hint: NETWORK_HINT,
            });
        }
        if (!defaultBranch || !isSafeBranchName(defaultBranch) || !decision.defaultSha) {
            throw new ExtensionOpError('BRANCH_UNKNOWN', '无法确定远端的默认分支。', { status: 502, stage: 'probe' });
        }
        if (!pristine && !force) {
            throw trackedBranch
                ? new ExtensionOpError('BRANCH_GONE', `远端已经没有「${trackedBranch}」分支了。`, {
                    status: 409,
                    stage: 'probe',
                    hint: `你在这个扩展里有自己的提交,所以没有自动切换。可以用强制更新切到默认分支「${defaultBranch}」(会先备份)。`,
                })
                : new ExtensionOpError('DETACHED_HEAD', '当前不在任何分支上,而且有自己的提交。', {
                    status: 409,
                    stage: 'probe',
                    hint: `可以用强制更新切到默认分支「${defaultBranch}」(会先备份)。`,
                });
        }
        fetchBranch = defaultBranch;
        localBranch = defaultBranch;
        switchTo = defaultBranch;
        targetSha = decision.defaultSha;
        switchNote = trackedBranch
            ? `远端已经没有「${trackedBranch}」分支,已切换到默认分支「${defaultBranch}」。`
            : `原来不在任何分支上,已切换到默认分支「${defaultBranch}」。`;
    }

    const upToDate = extra => upToDateOutcome({ op, dir, info, warnings, route: decision.agreeing[0]?.route.label ?? null, ...extra });
    if (!switchTo && await isContained(adapter, dir, targetSha, info.head)) {
        return upToDate();
    }

    let usedRoute = null;
    if (!(await adapter.hasCommit(dir, targetSha))) {
        stage(job, op, 'download', '正在下载更新');
        const fetched = await fetchWithRoutes({ env, job, op, check, dir, fetchBranch, shallow: info.shallow, expectedSha: targetSha });
        usedRoute = fetched.route;
        if (fetched.sha !== targetSha) {
            // 权威线路拿到的比探测时更新(刚好有人推送),以它为准
            op.setDetail('remoteMovedTo', fetched.sha);
            targetSha = fetched.sha;
            if (!switchTo && await isContained(adapter, dir, targetSha, info.head)) {
                await adapter.dropTempRef(dir, fetchBranch);
                return upToDate();
            }
        }
    }

    // 只有镜像结果时防一手:镜像给的版本比本地还旧、又不包含本地版本,多半是镜像没同步,不要拿旧版本覆盖
    if (!decision.authoritative && !usedRoute?.authoritative) {
        const [targetTime, headTime] = await Promise.all([adapter.commitTime(dir, targetSha), adapter.commitTime(dir, info.head)]);
        if (targetTime && headTime && targetTime < headTime && (await adapter.isAncestor(dir, info.head, targetSha)) !== true) {
            await adapter.dropTempRef(dir, fetchBranch);
            op.setDetail('staleSource', true);
            return upToDate({ staleSource: true, note: '镜像上的版本比本地还旧,可能镜像还没同步,这次没有更新。' });
        }
    }

    const fastForward = (await adapter.isAncestor(dir, info.head, targetSha)) === true;
    let canFollow = fastForward || pristine;
    if (!canFollow && info.tracking) {
        // 本地版本完全来自远端(没有自己的提交),远端改写了历史也可以直接跟上
        canFollow = info.tracking === info.head || (await adapter.isAncestor(dir, info.head, info.tracking)) === true;
    }
    op.setDetail('fastForward', fastForward);
    if (!canFollow && !force) {
        await adapter.dropTempRef(dir, fetchBranch);
        throw new ExtensionOpError('DIVERGED', '你在这个扩展里有自己的提交,和远端的更新对不上,没有自动更新。', {
            status: 409,
            stage: 'apply',
            hint: '如果不需要这些本地提交,可以用强制更新(会先备份整个目录,再对齐到最新版)。',
        });
    }

    stage(job, op, 'apply', '正在应用更新');
    const dirty = await adapter.listDirty(dir);
    let dirtyBackup = null;
    if (force) {
        await ensureBackup();
    } else if (dirty.length) {
        dirtyBackup = await backupFiles(dir, dirty.map(item => item.file), folder);
    }
    const move = { target: targetSha, branch: localBranch, createBranch: Boolean(switchTo), mode: force ? 'hard' : 'keep' };
    let applied = await adapter.moveTo(dir, move);
    // 文件被短暂占用(杀毒软件、索引服务):工作区本来就是干净的,可以放心用 hard 重试
    if (!applied.ok && applied.code === 'FILE_LOCKED' && (force || dirty.length === 0)) {
        for (let attempt = 1; attempt <= FILE_LOCK_RETRIES && !applied.ok && applied.code === 'FILE_LOCKED'; attempt++) {
            await delay(600 * attempt);
            applied = await adapter.moveTo(dir, { ...move, mode: 'hard' });
        }
    }

    if (!applied.ok) {
        await adapter.dropTempRef(dir, fetchBranch);
        if (applied.code === 'FILE_LOCKED') {
            // 写到一半失败:回到更新前,再把用户改过的文件放回去
            const restored = await adapter.moveTo(dir, { target: info.head, branch: info.branch ?? localBranch, createBranch: false, mode: 'hard' });
            const restoreFailed = dirtyBackup ? await restoreFiles(dirtyBackup, dir) : [];
            if (dirtyBackup && restored.ok && restoreFailed.length === 0) {
                await removeBackup(dirtyBackup.root);
            }
            throw new ExtensionOpError('FILE_LOCKED', `扩展的文件被占用,更新没能写入${restored.ok ? ',已恢复到更新前的状态' : ''}。`, {
                status: 409,
                stage: 'apply',
                hint: '关闭可能占用扩展文件的程序(编辑器、资源管理器预览、杀毒软件)后重试。',
                details: { detail: applied.detail, restored: restored.ok, restoreFailed, backup: restoreFailed.length ? dirtyBackup?.root : backupPath },
            });
        }
        if (dirtyBackup) {
            await removeBackup(dirtyBackup.root);
        }
        if (applied.code === 'LOCAL_CHANGES') {
            let files = applied.files;
            if (!files.length) {
                const changed = new Set((await adapter.changedFiles(dir, info.head, targetSha)) ?? []);
                files = dirty.map(item => item.file).filter(file => changed.has(file));
            }
            throw new ExtensionOpError('LOCAL_CHANGES', files.length ? `你改过这个扩展的文件,和更新冲突:${formatList(files)}` : '你改过这个扩展的文件,和更新冲突。', {
                status: 409,
                stage: 'apply',
                hint: '把这些文件改回去后再更新;或者用强制更新(会先备份整个目录,再覆盖成最新版)。',
                details: { files },
            });
        }
        throw new ExtensionOpError('APPLY_FAILED', `应用更新失败:${applied.detail || '未知错误'}`, { status: 500, stage: 'apply', details: { backup: backupPath } });
    }
    if (dirtyBackup) {
        // reset --keep 已经保留了不冲突的本地修改,备份用不上了
        await removeBackup(dirtyBackup.root);
    }

    const newHead = await adapter.readHead(dir);
    if (newHead !== targetSha) {
        throw new ExtensionOpError('APPLY_FAILED', `更新后的版本不对(期望 ${shortSha(targetSha)},实际 ${shortSha(newHead)})。`, { status: 500, stage: 'apply' });
    }

    stage(job, op, 'finalize', '收尾');
    const finalizeWarnings = await adapter.finalize(dir, { fetchBranch, target: targetSha, switchedTo: switchTo });
    if (finalizeWarnings.length) {
        op.setDetail('finalizeWarnings', finalizeWarnings);
    }
    const files = (await adapter.changedFiles(dir, info.head, targetSha)) ?? [];
    if (switchNote) {
        warnings.push(switchNote);
    }
    const summary = { from: info.head, to: targetSha, route: usedRoute?.label ?? null, changedFiles: files.length, forced: force, backupPath, switchedTo: switchTo, warnings };
    return {
        response: {
            shortCommitHash: shortSha(targetSha),
            extensionPath: dir,
            isUpToDate: false,
            remoteUrl: redactUrl(info.remoteUrl),
            baibaoku: { opId: op.id, ...summary, files: files.slice(0, 50) },
        },
        summary: `${shortSha(info.head)} → ${shortSha(targetSha)}`,
        logResult: summary,
    };
}

function upToDateOutcome({ op, dir, info, warnings, route, staleSource = false, note = null }) {
    return {
        response: {
            shortCommitHash: shortSha(info.head),
            extensionPath: dir,
            isUpToDate: true,
            remoteUrl: redactUrl(info.remoteUrl),
            baibaoku: { opId: op.id, route, staleSource, note, warnings },
        },
        summary: staleSource ? '镜像版本比本地旧,没有更新' : '已是最新',
        logResult: { upToDate: true, staleSource, warnings },
        // 自动更新每次都会走一遍,"已是最新"不写操作记录,免得把有用的记录挤掉
        skipLog: !staleSource && warnings.length === 0,
    };
}

async function fetchWithRoutes({ env, job, op, check, dir, fetchBranch, shallow, expectedSha }) {
    const failures = [];
    const mismatched = [];
    for (const route of orderFetchRoutes(check)) {
        throwIfAborted(job);
        job.update({ message: `正在下载更新(${route.label})`, progress: null });
        const result = await env.adapter.fetch(dir, route, {
            remoteBranch: fetchBranch,
            shallow,
            signal: job.signal,
            onProgress: progress => job.update({ progress }),
            timeoutMs: remainingMs(job),
            gitProxyKeys: env.proxyInfo.gitProxyKeys,
            expectedSha,
        });
        op.addAttempt({ label: route.label, kind: route.kind, phase: 'fetch', ok: result.ok, latencyMs: result.durationMs, error: result.ok ? null : result.failure, sha: result.sha });
        if (!result.ok) {
            failures.push({ route, failure: result.failure });
            recordRouteResult(check.cacheHost, { route, ok: false, latencyMs: result.durationMs, failure: result.failure });
            continue;
        }
        if (result.sha === expectedSha || route.authoritative) {
            return { route, sha: result.sha };
        }
        // 这个镜像给的版本和探测结果不一样(镜像之间没同步),换下一条
        mismatched.push(route.label);
    }
    throwIfAborted(job);
    if (mismatched.length) {
        // 对不上的版本已经下载到临时引用里了,清掉
        await env.adapter.dropTempRef(dir, fetchBranch);
        throw new ExtensionOpError('REMOTE_CHANGED', `各条线路给出的版本不一致(${formatList(mismatched)}),镜像可能还没同步,请稍后再试。`, {
            status: 409,
            stage: 'download',
            hint: NETWORK_HINT,
        });
    }
    throw downloadError(failures, '下载更新');
}

// ───────────────────────── 检查版本 ─────────────────────────

export async function checkExtensionVersion(req, body, { includeRemoteManifest = false, signal } = {}) {
    const target = resolveExistingTarget(req, body, { write: false });
    const env = await getEnvironment();
    const { adapter } = env;
    const started = Date.now();
    const notRepo = { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' };
    const gitDir = getGitDir(target.dir);
    if (!gitDir) {
        return notRepo;
    }
    const info = await adapter.inspect(target.dir);
    if (!info.isRepo || !info.head) {
        return notRepo;
    }
    const base = { currentBranchName: info.branch ?? '', currentCommitHash: info.head, remoteUrl: redactUrl(info.remoteUrl) };
    if (!info.remoteUrl) {
        return { ...base, isUpToDate: true };
    }
    const remote = parseRemoteUrl(info.remoteUrl, { domainMirrors: domainMirrorsOf(env.config) });
    const failed = (message, extra = {}) => ({
        ...base,
        isUpToDate: true,
        baibaoku: { remoteCheckFailed: true, error: message, elapsedMs: Date.now() - started, ...extra },
    });
    if (env.backend === 'builtin' && !remote.isHttp) {
        return failed('内置 git 只支持 http/https 地址');
    }

    const trackedBranch = info.branch && info.upstream && isSafeBranchName(info.upstream) ? info.upstream : null;
    const op = new OpRecorder({ kind: 'version', user: getUserHandle(req), extension: target.folder, global: target.global, backend: env.backend, gitVersion: env.gitVersion, source: remote.display });
    let check;
    try {
        check = await checkRemote({
            remote,
            branch: trackedBranch,
            purpose: 'version',
            backend: env.backend,
            config: env.config,
            proxyInfo: env.proxyInfo,
            localHead: info.head,
            signal: anySignal([signal, AbortSignal.timeout(env.config.probeTimeoutMs * 2 + 5000)]),
            onResult: result => op.addProbeResult(result),
        });
    } catch (error) {
        if (!(error instanceof ExtensionOpError)) throw error;
        return failed(error.message);
    }
    const decision = check.decision;
    if (!decision) {
        if (signal?.aborted) {
            // 前端已经不等了(切走页面、关掉扩展面板),不算失败
            return failed('已取消');
        }
        // 版本检查很频繁,只有连不上时才留记录,方便诊断
        const error = unreachableError(check, '检查更新', remote);
        op.finish({ ok: false, code: error.code, message: error.message, hint: error.hint });
        return failed(error.message, { hint: error.hint, opId: op.id });
    }

    let remoteCommit;
    let isUpToDate;
    let branchGone = false;
    if (trackedBranch && decision.branchFound) {
        remoteCommit = decision.sha;
        isUpToDate = await isContained(adapter, target.dir, remoteCommit, info.head);
    } else if (trackedBranch && !decision.authoritative) {
        // 只有镜像说分支不存在,不可信
        return failed(`镜像上找不到「${trackedBranch}」分支`);
    } else {
        // 游离 HEAD 或远端删了分支:纯净安装在更新时会自动切到默认分支,只有这种情况提示有更新
        branchGone = Boolean(trackedBranch);
        remoteCommit = decision.defaultSha;
        const pristine = !(await hasLocalCommitsInReflog(gitDir));
        isUpToDate = !(pristine && remoteCommit && !(await isContained(adapter, target.dir, remoteCommit, info.head)));
    }

    const result = {
        ...base,
        isUpToDate,
        baibaoku: {
            remoteCommit,
            remoteBranch: trackedBranch ?? decision.defaultBranch,
            route: decision.agreeing[0]?.route.label ?? null,
            authoritative: decision.authoritative,
            branchGone,
            detached: !info.branch,
            elapsedMs: Date.now() - started,
        },
    };
    if (includeRemoteManifest && !isUpToDate && remoteCommit) {
        result.baibaoku.remoteManifest = await fetchRemoteManifest({
            remote,
            sha: remoteCommit,
            routes: decision.agreeing.map(item => item.route),
            signal,
        });
    }
    return result;
}

// ───────────────────────── 删除 ─────────────────────────

export async function deleteExtension(req, body, { clientId = null, source = 'api' } = {}) {
    const target = resolveExistingTarget(req, body, { write: true });
    const env = await getEnvironment();
    return runOperation({
        req,
        env,
        target,
        clientId,
        source,
        kind: 'delete',
        signature: 'delete',
    }, (job, op) => performDelete({ req, job, op, target }));
}

async function performDelete({ req, job, op, target }) {
    stage(job, op, 'delete', '正在删除');
    const warnings = [];
    let trashPath = null;
    try {
        // 先挪进回收区(保留 7 天),误删还能找回来
        const trashed = await moveToTrash(target.dir, { reason: 'delete', extension: target.folder, user: getUserHandle(req), global: target.global });
        trashPath = trashed.trashPath;
        if (trashed.leftover) {
            warnings.push('有部分文件被占用没能删掉,酒馆已经不会再加载这个扩展,可以稍后在「残留目录」里清理。');
        }
    } catch (error) {
        op.setDetail('trashError', error?.code ?? error?.message ?? String(error));
        let removal;
        try {
            removal = await removeExtensionDir(target.dir);
        } catch (removeError) {
            throw new ExtensionOpError('DELETE_FAILED', `删除失败,文件被占用:${removeError?.code ?? removeError?.message ?? removeError}`, {
                status: 500,
                stage: 'delete',
                hint: '关闭可能占用扩展目录的程序(编辑器、资源管理器、杀毒软件)后重试。',
                cause: removeError,
            });
        }
        if (removal.leftover) {
            warnings.push('有部分文件被占用没能删掉,酒馆已经不会再加载这个扩展,可以稍后在「残留目录」里清理。');
        }
    }
    return {
        text: `Extension has been deleted at ${target.dir}`,
        response: { deleted: true, extensionPath: target.dir, trashPath, warnings, opId: op.id },
        summary: trashPath ? '已移到回收区' : '已删除',
        logResult: { trashPath, warnings },
    };
}

// ───────────────────────── 残留目录 ─────────────────────────

export async function listResiduals(req) {
    const bases = [{ base: getUserExtensionsBase(req), global: false }];
    if (isAdmin(req)) {
        bases.push({ base: getGlobalExtensionsBase(), global: true });
    }
    const items = [];
    for (const { base, global } of bases) {
        let entries = [];
        try {
            entries = await fsp.readdir(base, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.toLowerCase().startsWith(RESERVED_PREFIX) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
            const dir = path.join(base, entry.name);
            const state = await classifyFolder(dir);
            if (!state.residual) continue;
            items.push({ name: entry.name, global, path: dir, entryCount: state.entryCount, hasGit: state.hasGit, modifiedAt: state.modifiedAt });
        }
    }
    return items;
}

export async function cleanResiduals(req, body) {
    // 要么列出具体目录,要么明确传 all: true,避免空请求误清全部
    const wanted = Array.isArray(body?.items) ? body.items : body?.all === true ? null : [];
    const user = getUserHandle(req);
    const all = await listResiduals(req);
    const targets = wanted
        ? all.filter(item => wanted.some(entry => entry?.name === item.name && Boolean(entry?.global) === item.global))
        : all;
    const results = [];
    for (const item of targets) {
        try {
            const { promise } = runJob({
                key: makeLockKey(item.path),
                signature: 'clean-residual',
                kind: 'delete',
                user,
                extension: item.name,
                timeoutMs: 120_000,
            }, async () => {
                // 列出之后可能有变化,动手前再确认一次它还是残留
                const state = await classifyFolder(item.path);
                if (!state.exists || !state.residual) {
                    return { skipped: true };
                }
                const trashed = await moveToTrash(item.path, { reason: 'residual-clean', extension: item.name, user });
                return { trashPath: trashed.trashPath, leftover: trashed.leftover };
            });
            results.push({ name: item.name, global: item.global, ok: true, ...await promise });
        } catch (error) {
            results.push({ name: item.name, global: item.global, ok: false, error: error?.message ?? String(error) });
        }
    }
    return { results };
}

// ───────────────────────── 线路测试 / 状态 / 配置 ─────────────────────────

export async function testRoutes(req, body) {
    const env = await getEnvironment({ forceProxyDetect: true });
    const url = typeof body?.url === 'string' && body.url.trim() ? body.url.trim() : DEFAULT_TEST_URL;
    const remote = parseRemoteUrl(url, { domainMirrors: domainMirrorsOf(env.config) });
    if (!remote.isHttp) {
        throw new ExtensionOpError('INVALID_URL', '测试地址需要是 http/https 仓库地址。', { status: 400, stage: 'validate' });
    }
    const started = Date.now();
    const check = await checkRemote({
        remote,
        branch: null,
        purpose: 'test',
        backend: env.backend,
        config: env.config,
        proxyInfo: env.proxyInfo,
        exhaustive: true,
        includeCloud: true,
        // 内置线路、读云端列表、云端线路是先后三轮,超时要留够
        signal: AbortSignal.timeout(env.config.probeTimeoutMs * 2 + 15000),
    });
    const admin = isAdmin(req);
    return {
        target: remote.display,
        backend: env.backend,
        elapsedMs: Date.now() - started,
        proxies: env.proxyInfo.candidates.map(candidate => describeProxy(candidate, { reveal: admin })),
        routes: check.routes.map(route => {
            const result = check.results.find(item => item.route.id === route.id);
            return {
                id: redactUrl(route.id),
                label: route.label,
                kind: route.kind,
                authoritative: route.authoritative,
                ok: Boolean(result?.ok),
                latencyMs: result?.latencyMs ?? null,
                commit: result?.refs?.defaultSha ?? null,
                error: result?.ok ? null : result?.failure ?? { kind: 'aborted', summary: '没有完成', detail: '' },
            };
        }),
        decision: check.decision
            ? { commit: check.decision.sha, authoritative: check.decision.authoritative, defaultBranch: check.decision.defaultBranch }
            : null,
        cloud: check.cloud ?? null,
    };
}

export async function getManagerStatus(req) {
    const env = await getEnvironment();
    const admin = isAdmin(req);
    const { config } = env;
    return {
        interceptEnabled: config.interceptEnabled,
        backend: env.backend,
        preferredBackend: env.preferredBackend,
        gitVersion: env.gitVersion,
        isomorphicGitVersion: getIsomorphicGitVersion(),
        isAdmin: admin,
        config: admin ? config : { interceptEnabled: config.interceptEnabled, prefixMirrors: config.prefixMirrors, domainMirrors: config.domainMirrors },
        defaults: admin ? { prefixMirrors: DEFAULT_PREFIX_MIRRORS, domainMirrors: DEFAULT_DOMAIN_MIRRORS, localProxyPorts: DEFAULT_LOCAL_PROXY_PORTS } : null,
        proxies: env.proxyInfo.candidates.map(candidate => describeProxy(candidate, { reveal: admin })),
        routeStats: getRouteStatsSnapshot(),
        jobs: listJobs({ user: getUserHandle(req), admin }),
    };
}

// 柏宝箱「插件安装优化」开关只读写 interceptEnabled;代理、镜像等其余配置没有界面,一律自动处理。
export function getManagerConfig(req) {
    return { interceptEnabled: loadConfig().interceptEnabled, isAdmin: isAdmin(req) };
}

export async function updateManagerConfig(req, patch) {
    if (!isAdmin(req)) {
        throw new ExtensionOpError('FORBIDDEN', '只有管理员可以开关「插件安装优化」。', { status: 403, stage: 'validate' });
    }
    const clean = Object.fromEntries(Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([key]) => CONFIG_KEYS.includes(key)));
    const config = saveConfig(clean);
    if (Object.keys(clean).some(key => key !== 'interceptEnabled')) {
        await detectProxies(config, { force: true });
    }
    return getManagerConfig(req);
}

export function getJobForRequest(req, id) {
    const job = getJob(String(id ?? ''));
    if (!job || (!isAdmin(req) && job.user !== getUserHandle(req))) {
        throw new ExtensionOpError('JOB_NOT_FOUND', '找不到这个任务(可能已经结束超过 10 分钟)。', { status: 404 });
    }
    return job.toJSON();
}

/**
 * 前端一次查多个任务的进度(批量更新时不用每个任务各发一个请求);查不到或不是自己的任务给 null。
 */
export function getJobsForRequest(req, ids) {
    const admin = isAdmin(req);
    const user = getUserHandle(req);
    const wanted = [...new Set(String(ids ?? '').split(',').map(id => id.trim()).filter(Boolean))].slice(0, 50);
    return Object.fromEntries(wanted.map(id => {
        const job = getJob(id);
        return [id, job && (admin || job.user === user) ? job.toJSON() : null];
    }));
}

export function listOpsForRequest(req, query = {}) {
    return listOps({
        user: getUserHandle(req),
        admin: isAdmin(req),
        limit: Number(query.limit) || 50,
        kind: typeof query.kind === 'string' && query.kind ? query.kind : null,
        failedOnly: query.failedOnly === true || query.failedOnly === 'true' || query.failedOnly === '1',
    });
}

export function getOpForRequest(req, id) {
    const entry = getOp(String(id ?? ''), { user: getUserHandle(req), admin: isAdmin(req) });
    if (!entry) {
        throw new ExtensionOpError('OP_NOT_FOUND', '找不到这条操作记录。', { status: 404 });
    }
    return entry;
}

/**
 * 插件启动时(还没开始接请求):读回线路记录和操作记录,清掉上次中断留下的临时目录;过期的回收区和备份放到后台清。
 */
export async function startExtensionManager() {
    loadRouteStats();
    loadOps();
    const bases = [getGlobalExtensionsBase(), ...listUserExtensionBases()];
    for (const base of bases) {
        await sweepStagingDir(base);
    }
    void sweepManagerDirs().catch(error => console.warn('[BaiBaoKu] 清理扩展回收区失败:', error?.message ?? error));
}
