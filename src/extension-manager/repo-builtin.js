import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { createGitHttpClient } from './builtin-http.js';
import { clearInProgressState, getGitDir } from './repo-fs.js';
import { tempRefName } from './repo-system.js';
import { classifyBuiltinError } from './sources.js';
import { anySignal } from './util.js';

const FILE_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function toProgress(onProgress) {
    if (!onProgress) return undefined;
    return event => {
        try {
            const percent = event.total ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null;
            onProgress({ phase: event.phase, percent, speed: '' });
        } catch {
            // 进度回调出错不影响下载
        }
    };
}

async function resolveOrNull(dir, ref) {
    try {
        return await git.resolveRef({ fs, dir, ref });
    } catch {
        return null;
    }
}

async function hasCommit(dir, sha) {
    if (!sha) return false;
    try {
        await git.readCommit({ fs, dir, oid: sha });
        return true;
    } catch {
        return false;
    }
}

function isFileLockError(error) {
    return FILE_LOCK_CODES.has(error?.code) || /EPERM|EBUSY|EACCES/.test(String(error?.message ?? ''));
}

/**
 * 没装 git(或 config.yaml 指定 builtin)时用 isomorphic-git 实现同样的接口。
 * 能力比系统 git 少:没有 reset --keep,用"移动分支 + checkout(冲突检测)"代替。
 */
export const builtinRepo = {
    name: 'builtin',

    async inspect(dir) {
        const gitDir = getGitDir(dir);
        if (!gitDir) {
            return { isRepo: false, detail: '没有 .git' };
        }
        const head = await resolveOrNull(dir, 'HEAD');
        let branch = null;
        try {
            branch = (await git.currentBranch({ fs, dir, fullname: false })) || null;
        } catch {
            branch = null;
        }
        let remoteUrl = '';
        let upstream = branch;
        try {
            remoteUrl = String((await git.getConfig({ fs, dir, path: 'remote.origin.url' })) ?? '');
            if (branch) {
                const merge = await git.getConfig({ fs, dir, path: `branch.${branch}.merge` });
                if (typeof merge === 'string' && merge.startsWith('refs/heads/')) {
                    upstream = merge.slice('refs/heads/'.length);
                }
            }
        } catch {
            // 配置读不出来就当没有
        }
        const tracking = upstream ? await resolveOrNull(dir, `refs/remotes/origin/${upstream}`) : null;
        return {
            isRepo: true,
            head,
            branch,
            upstream,
            shallow: fs.existsSync(path.join(gitDir, 'shallow')),
            remoteUrl,
            tracking,
        };
    },

    async readHead(dir) {
        return resolveOrNull(dir, 'HEAD');
    },

    async listDirty(dir) {
        try {
            const matrix = await git.statusMatrix({ fs, dir });
            return matrix
                .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1) && !(head === 0 && stage === 0))
                .map(([file, head, workdir]) => ({ file, status: head === 0 ? 'A ' : workdir === 0 ? ' D' : ' M' }));
        } catch {
            return [];
        }
    },

    hasCommit,

    async isAncestor(dir, ancestor, descendant) {
        if (!ancestor || !descendant) return false;
        if (ancestor === descendant) return true;
        try {
            return await git.isDescendent({ fs, dir, oid: descendant, ancestor, depth: -1 });
        } catch {
            return null;
        }
    },

    async commitTime(dir, sha) {
        try {
            const { commit } = await git.readCommit({ fs, dir, oid: sha });
            return commit.committer?.timestamp ?? null;
        } catch {
            return null;
        }
    },

    async changedFiles(dir, from, to) {
        const files = [];
        try {
            await git.walk({
                fs,
                dir,
                trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
                map: async (filepath, [a, b]) => {
                    const [oidA, oidB, typeA, typeB] = await Promise.all([a?.oid(), b?.oid(), a?.type(), b?.type()]);
                    if (oidA && oidA === oidB) {
                        // 完全相同的目录/文件,不用再往下走
                        return null;
                    }
                    if (typeA === 'blob' || typeB === 'blob') {
                        files.push(filepath);
                    }
                    return undefined;
                },
            });
        } catch {
            return null;
        }
        return files.sort();
    },

    async sameTree(dir, a, b) {
        try {
            const [left, right] = await Promise.all([git.readCommit({ fs, dir, oid: a }), git.readCommit({ fs, dir, oid: b })]);
            return left.commit.tree === right.commit.tree;
        } catch {
            return null;
        }
    },

    async fetch(dir, route, { remoteBranch, shallow, signal, onProgress, timeoutMs, expectedSha }) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const client = createGitHttpClient({ proxy: route.proxy, signal: anySignal([signal, timeout]) });
        const started = Date.now();
        try {
            let sha = null;
            try {
                const result = await git.fetch({
                    fs,
                    http: client,
                    dir,
                    url: route.url,
                    ref: remoteBranch,
                    remoteRef: `refs/heads/${remoteBranch}`,
                    singleBranch: true,
                    tags: false,
                    depth: shallow ? 1 : null,
                    onProgress: toProgress(onProgress),
                });
                sha = result.fetchHead;
            } catch (error) {
                // 仓库里没有 remote.origin.fetch 配置时,isomorphic-git 在下载完成之后才报错,对象其实已经存下来了
                if (error?.code === 'NoRefspecError' && await hasCommit(dir, expectedSha)) {
                    sha = expectedSha;
                } else {
                    throw error;
                }
            }
            if (!sha) {
                return { ok: false, failure: { kind: 'not-found', summary: '远端是空仓库', detail: '' }, durationMs: Date.now() - started };
            }
            await git.writeRef({ fs, dir, ref: tempRefName(remoteBranch), value: sha, force: true });
            return { ok: true, sha, durationMs: Date.now() - started };
        } catch (error) {
            return {
                ok: false,
                failure: classifyBuiltinError(error, { timedOut: timeout.aborted, aborted: Boolean(signal?.aborted) }),
                durationMs: Date.now() - started,
            };
        } finally {
            client.destroy();
        }
    },

    async moveTo(dir, { target, branch, createBranch, mode }) {
        const ref = `refs/heads/${branch}`;
        const previous = await resolveOrNull(dir, ref);
        try {
            await git.writeRef({ fs, dir, ref, value: target, force: true });
            await git.checkout({ fs, dir, ref, force: mode === 'hard' });
            return { ok: true };
        } catch (error) {
            // checkout 在检测到冲突时什么文件都没写,把分支指回去即可
            if (previous) {
                await git.writeRef({ fs, dir, ref, value: previous, force: true }).catch(() => {});
            } else if (createBranch) {
                await git.deleteRef({ fs, dir, ref }).catch(() => {});
            }
            const detail = String(error?.message ?? error).slice(0, 240);
            if (error?.code === 'CheckoutConflictError') {
                return { ok: false, code: 'LOCAL_CHANGES', files: error.data?.filepaths ?? [], detail };
            }
            if (isFileLockError(error)) {
                return { ok: false, code: 'FILE_LOCKED', files: [], detail };
            }
            return { ok: false, code: 'FAILED', files: [], detail };
        }
    },

    async finalize(dir, { fetchBranch, target, switchedTo }) {
        const warnings = [];
        const attempt = async (label, task) => {
            try {
                await task();
            } catch (error) {
                warnings.push(`${label}:${error?.message ?? error}`);
            }
        };
        await attempt('更新远端跟踪分支', () => git.writeRef({ fs, dir, ref: `refs/remotes/origin/${fetchBranch}`, value: target, force: true }));
        await git.deleteRef({ fs, dir, ref: tempRefName(fetchBranch) }).catch(() => {});
        if (switchedTo) {
            await attempt('设置上游', async () => {
                await git.setConfig({ fs, dir, path: `branch.${switchedTo}.remote`, value: 'origin' });
                await git.setConfig({ fs, dir, path: `branch.${switchedTo}.merge`, value: `refs/heads/${switchedTo}` });
            });
            await attempt('添加 fetch 规则', async () => {
                const specs = await git.getConfigAll({ fs, dir, path: 'remote.origin.fetch' });
                const covered = specs.some(spec => {
                    const source = String(spec).replace(/^\+/, '').split(':')[0];
                    return source === 'refs/heads/*' || source === `refs/heads/${switchedTo}`;
                });
                if (!covered) {
                    await git.setConfig({ fs, dir, path: 'remote.origin.fetch', value: `+refs/heads/${switchedTo}:refs/remotes/origin/${switchedTo}`, append: true });
                }
            });
        }
        return warnings;
    },

    async dropTempRef(dir, fetchBranch) {
        await git.deleteRef({ fs, dir, ref: tempRefName(fetchBranch) }).catch(() => {});
    },

    async abortInProgress(dir, state) {
        const gitDir = getGitDir(dir);
        if (!gitDir) {
            return { ok: false, detail: '没有 .git' };
        }
        if (state.rebase || state.cherryPick || state.revert) {
            return { ok: false, detail: '内置 git 不能撤销进行中的 rebase/cherry-pick/revert' };
        }
        if (state.merge) {
            try {
                await git.abortMerge({ fs, dir });
            } catch (error) {
                return { ok: false, detail: String(error?.message ?? error).slice(0, 240) };
            }
        }
        await clearInProgressState(gitDir);
        return { ok: true };
    },

    async clone(route, dest, { branch, signal, onProgress, timeoutMs }) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const client = createGitHttpClient({ proxy: route.proxy, signal: anySignal([signal, timeout]) });
        const started = Date.now();
        try {
            await git.clone({
                fs,
                http: client,
                dir: dest,
                url: route.url,
                ref: branch || undefined,
                singleBranch: true,
                depth: 1,
                noTags: true,
                onProgress: toProgress(onProgress),
            });
            return { ok: true, durationMs: Date.now() - started };
        } catch (error) {
            return {
                ok: false,
                failure: classifyBuiltinError(error, { timedOut: timeout.aborted, aborted: Boolean(signal?.aborted) }),
                durationMs: Date.now() - started,
            };
        } finally {
            client.destroy();
        }
    },

    async setOrigin(dir, url) {
        try {
            await git.setConfig({ fs, dir, path: 'remote.origin.url', value: url });
            return true;
        } catch {
            return false;
        }
    },
};
