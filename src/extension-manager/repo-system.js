import fs from 'node:fs';
import path from 'node:path';
import { classifyGitFailure } from './errors.js';
import { runGit } from './git-runner.js';
import { samePath } from './repo-fs.js';
import { lastMeaningfulLine } from './util.js';

const LOCAL_TIMEOUT_MS = 120000;
export const LOCAL_CHANGES_PATTERN = /not uptodate|would be overwritten|Your local changes|untracked working tree file/i;
export const FILE_LOCK_PATTERN = /unable to unlink|unable to create|Permission denied|Invalid argument|Device or resource busy|Resource busy|cannot create directory|failed to write|Deletion of directory|Unlink of file|could not open .* for writing/i;

export function tempRefName(branch) {
    return `refs/baibaoku/update/${branch}`;
}

// 远端分支名来自网络,用之前确认它是正常的分支名,避免被当成命令行参数
export function isSafeBranchName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= 200
        && !name.startsWith('-')
        && !name.startsWith('/')
        && !name.endsWith('/')
        && !name.endsWith('.lock')
        && !name.includes('..')
        && !name.includes('@{')
        && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
}

function local(dir, args, options = {}) {
    return runGit(args, { repoDir: dir, cwd: dir, timeoutMs: LOCAL_TIMEOUT_MS, ...options });
}

async function localText(dir, args) {
    const result = await local(dir, args);
    return result.code === 0 ? result.stdout.trim() : '';
}

function realpathSafe(dir) {
    try {
        return fs.realpathSync.native(dir);
    } catch {
        return dir;
    }
}

export function parseConflictFiles(stderr) {
    const files = new Set();
    const lines = String(stderr ?? '').split(/\r?\n/);
    let inList = false;
    for (const line of lines) {
        if (/would be overwritten|not uptodate/i.test(line)) {
            for (const match of line.matchAll(/'([^']+)'/g)) {
                files.add(match[1]);
            }
            inList = /:\s*$/.test(line);
            continue;
        }
        if (inList && /^\t/.test(line)) {
            files.add(line.trim());
            continue;
        }
        inList = false;
    }
    return [...files];
}

export const systemRepo = {
    name: 'system',

    async inspect(dir) {
        const top = await local(dir, ['rev-parse', '--show-toplevel']);
        const topPath = top.stdout.trim();
        if (top.code !== 0 || !topPath || !(samePath(topPath, dir) || samePath(topPath, realpathSafe(dir)))) {
            return { isRepo: false, detail: lastMeaningfulLine(top.stderr) };
        }
        const [head, branch, shallow, remoteUrl] = await Promise.all([
            localText(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
            localText(dir, ['symbolic-ref', '-q', '--short', 'HEAD']),
            localText(dir, ['rev-parse', '--is-shallow-repository']),
            localText(dir, ['config', '--get', 'remote.origin.url']),
        ]);
        let upstream = branch || null;
        if (branch) {
            const merge = await localText(dir, ['config', '--get', `branch.${branch}.merge`]);
            if (merge.startsWith('refs/heads/')) {
                upstream = merge.slice('refs/heads/'.length);
            }
        }
        const tracking = upstream ? await localText(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${upstream}^{commit}`]) : '';
        return {
            isRepo: true,
            head: head || null,
            branch: branch || null,
            upstream,
            shallow: shallow === 'true',
            remoteUrl,
            tracking: tracking || null,
        };
    },

    async readHead(dir) {
        return (await localText(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])) || null;
    },

    async listDirty(dir) {
        const result = await local(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
        if (result.code !== 0) {
            return [];
        }
        const entries = result.stdout.split('\0');
        const files = [];
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry || entry.length < 4) continue;
            const status = entry.slice(0, 2);
            files.push({ status, file: entry.slice(3) });
            if (status[0] === 'R' || status[0] === 'C') {
                index++;
            }
        }
        return files;
    },

    async hasCommit(dir, sha) {
        if (!sha) return false;
        return (await local(dir, ['cat-file', '-e', `${sha}^{commit}`])).code === 0;
    },

    async isAncestor(dir, ancestor, descendant) {
        if (!ancestor || !descendant) return false;
        if (ancestor === descendant) return true;
        const result = await local(dir, ['merge-base', '--is-ancestor', ancestor, descendant]);
        if (result.code === 0) return true;
        if (result.code === 1) return false;
        return null;
    },

    async commitTime(dir, sha) {
        const text = await localText(dir, ['log', '-1', '--format=%ct', sha, '--']);
        const value = Number(text);
        return Number.isFinite(value) && value > 0 ? value : null;
    },

    async changedFiles(dir, from, to) {
        const result = await local(dir, ['diff', '--name-only', '-z', '--no-renames', from, to, '--']);
        if (result.code !== 0) return null;
        return result.stdout.split('\0').filter(Boolean);
    },

    async sameTree(dir, a, b) {
        const [treeA, treeB] = await Promise.all([
            localText(dir, ['rev-parse', '--verify', '-q', `${a}^{tree}`]),
            localText(dir, ['rev-parse', '--verify', '-q', `${b}^{tree}`]),
        ]);
        return treeA && treeB ? treeA === treeB : null;
    },

    async fetch(dir, route, { remoteBranch, shallow, signal, onProgress, timeoutMs, gitProxyKeys }) {
        const tempRef = tempRefName(remoteBranch);
        const args = ['fetch', '--no-tags', '--progress'];
        if (shallow) {
            args.push('--depth=1');
        }
        args.push('--', route.url, `+refs/heads/${remoteBranch}:${tempRef}`);
        const result = await runGit(args, { repoDir: dir, cwd: dir, timeoutMs, network: route, gitProxyKeys, signal, onProgress });
        if (result.code !== 0) {
            return { ok: false, failure: classifyGitFailure(result.stderr, result), durationMs: result.durationMs };
        }
        const sha = await localText(dir, ['rev-parse', '--verify', '-q', `${tempRef}^{commit}`]);
        if (!sha) {
            return { ok: false, failure: { kind: 'unknown', summary: '下载完成但没有拿到版本', detail: lastMeaningfulLine(result.stderr) }, durationMs: result.durationMs };
        }
        return { ok: true, sha, durationMs: result.durationMs };
    },

    /**
     * 把工作区移到目标版本。
     * keep:相当于 git reset --keep,保留和更新不冲突的本地修改,有冲突就整个拒绝、什么都不写;
     * hard:强制对齐(调用方负责先备份)。切换分支时用 checkout -B。
     */
    async moveTo(dir, { target, branch, createBranch, mode }) {
        const args = createBranch
            ? ['checkout', ...(mode === 'hard' ? ['-f'] : []), '-B', branch, target]
            : ['reset', mode === 'hard' ? '--hard' : '--keep', target];
        const result = await local(dir, args);
        if (result.code === 0) {
            return { ok: true };
        }
        const detail = lastMeaningfulLine(result.stderr);
        if (LOCAL_CHANGES_PATTERN.test(result.stderr)) {
            return { ok: false, code: 'LOCAL_CHANGES', files: parseConflictFiles(result.stderr), detail };
        }
        if (FILE_LOCK_PATTERN.test(result.stderr)) {
            return { ok: false, code: 'FILE_LOCKED', files: [], detail };
        }
        return { ok: false, code: 'FAILED', files: [], detail };
    },

    async finalize(dir, { fetchBranch, target, switchedTo }) {
        const warnings = [];
        const run = async (args, label) => {
            const result = await local(dir, args);
            if (result.code !== 0) warnings.push(`${label}:${lastMeaningfulLine(result.stderr)}`);
            return result;
        };
        await run(['update-ref', `refs/remotes/origin/${fetchBranch}`, target], '更新远端跟踪分支');
        // 版本已经在本地、没走下载时临时引用不存在,删不掉也无所谓
        await local(dir, ['update-ref', '-d', tempRefName(fetchBranch)]);
        if (switchedTo) {
            await run(['config', `branch.${switchedTo}.remote`, 'origin'], '设置上游');
            await run(['config', `branch.${switchedTo}.merge`, `refs/heads/${switchedTo}`], '设置上游');
            const specs = (await local(dir, ['config', '--get-all', 'remote.origin.fetch'])).stdout.split(/\r?\n/).filter(Boolean);
            const covered = specs.some(spec => {
                const source = spec.replace(/^\+/, '').split(':')[0];
                return source === 'refs/heads/*' || source === `refs/heads/${switchedTo}`;
            });
            if (!covered) {
                await run(['config', '--add', 'remote.origin.fetch', `+refs/heads/${switchedTo}:refs/remotes/origin/${switchedTo}`], '添加 fetch 规则');
            }
        }
        return warnings;
    },

    async dropTempRef(dir, fetchBranch) {
        await local(dir, ['update-ref', '-d', tempRefName(fetchBranch)]);
    },

    async abortInProgress(dir, state) {
        const commands = [];
        if (state.merge) commands.push(['merge', '--abort']);
        if (state.rebase) commands.push(['rebase', '--abort']);
        if (state.cherryPick) commands.push(['cherry-pick', '--abort']);
        if (state.revert) commands.push(['revert', '--abort']);
        for (const args of commands) {
            const result = await local(dir, args);
            if (result.code !== 0) {
                return { ok: false, detail: lastMeaningfulLine(result.stderr) };
            }
        }
        return { ok: true };
    },

    async clone(route, dest, { branch, signal, onProgress, timeoutMs, gitProxyKeys }) {
        const args = ['clone', '--depth', '1', '--progress'];
        if (branch) {
            args.push('--branch', branch);
        }
        args.push('--', route.url, dest);
        const result = await runGit(args, { cwd: path.dirname(dest), timeoutMs, network: route, gitProxyKeys, signal, onProgress });
        if (result.code !== 0) {
            return { ok: false, failure: classifyGitFailure(result.stderr, result), durationMs: result.durationMs };
        }
        return { ok: true, durationMs: result.durationMs };
    },

    async setOrigin(dir, url) {
        const result = await local(dir, ['remote', 'set-url', 'origin', url]);
        if (result.code !== 0) {
            const added = await local(dir, ['remote', 'add', 'origin', url]);
            return added.code === 0;
        }
        return true;
    },
};
