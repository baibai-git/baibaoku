import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const STALE_LOCK_MS = 10 * 60_000;
const LOCK_FILES = ['index.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'packed-refs.lock', 'ORIG_HEAD.lock', 'FETCH_HEAD.lock'];
// reflog 里这些动作说明有人在这个目录里自己提交过,不能当成"纯净安装"直接对齐远端
const LOCAL_COMMIT_REFLOG = /^(commit( \((amend|initial|merge)\))?|cherry-pick|revert|am):/i;

export async function readManifest(dir) {
    const file = path.join(dir, 'manifest.json');
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch (error) {
        return { ok: false, missing: error?.code === 'ENOENT', error: error?.message ?? String(error) };
    }
    try {
        const manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            return { ok: false, missing: false, error: 'manifest.json 不是对象' };
        }
        return { ok: true, manifest };
    } catch (error) {
        return { ok: false, missing: false, error: `manifest.json 不是合法 JSON:${error.message}` };
    }
}

/**
 * 判断目录状态。没有 manifest.json 的目录酒馆不会列出来,却会挡住同名安装 —— 这就是"装一半"的残留。
 */
export async function classifyFolder(dir) {
    let stat;
    try {
        stat = await fsp.lstat(dir);
    } catch {
        return { exists: false, residual: false };
    }
    if (stat.isSymbolicLink()) {
        // 开发者常把自己的扩展链接进来,按链接指向的目录判断;指向不存在的链接才算残留
        stat = await fsp.stat(dir).catch(() => stat);
    }
    if (!stat.isDirectory()) {
        return { exists: true, isDirectory: false, residual: true, hasManifest: false, hasGit: false, entryCount: 0, modifiedAt: stat.mtimeMs };
    }
    let entries = [];
    try {
        entries = await fsp.readdir(dir);
    } catch {
        entries = [];
    }
    const hasManifest = entries.includes('manifest.json') && fs.existsSync(path.join(dir, 'manifest.json'));
    return {
        exists: true,
        isDirectory: true,
        residual: !hasManifest,
        hasManifest,
        hasGit: entries.includes('.git'),
        entryCount: entries.length,
        modifiedAt: stat.mtimeMs,
    };
}

export function getGitDir(dir) {
    const gitPath = path.join(dir, '.git');
    try {
        const stat = fs.statSync(gitPath);
        if (stat.isDirectory()) {
            return gitPath;
        }
        if (stat.isFile()) {
            const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
            return match ? path.resolve(dir, match[1].trim()) : null;
        }
    } catch {
        return null;
    }
    return null;
}

export async function readHeadReflogMessages(gitDir) {
    try {
        const text = await fsp.readFile(path.join(gitDir, 'logs', 'HEAD'), 'utf8');
        return text.split(/\r?\n/).map(line => line.split('\t').slice(1).join('\t')).filter(Boolean);
    } catch {
        return [];
    }
}

export async function hasLocalCommitsInReflog(gitDir) {
    const messages = await readHeadReflogMessages(gitDir);
    return messages.some(message => LOCAL_COMMIT_REFLOG.test(message));
}

export async function getInProgressState(gitDir) {
    const exists = name => fs.existsSync(path.join(gitDir, name));
    return {
        merge: exists('MERGE_HEAD'),
        rebase: exists('rebase-merge') || exists('rebase-apply'),
        cherryPick: exists('CHERRY_PICK_HEAD'),
        revert: exists('REVERT_HEAD'),
    };
}

// 撤销不了进行中的 merge/rebase 时(内置 git 不支持,或用户选择强制更新且已备份),直接清掉状态文件
export async function clearInProgressState(gitDir) {
    const names = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
    await Promise.all(names.map(name => fsp.rm(path.join(gitDir, name), { recursive: true, force: true }).catch(() => {})));
}

/**
 * 清理被硬杀的 git 留下的锁文件。超过 10 分钟的视为残留直接删;更新的锁说明可能真有 git 在跑,交给调用方报错。
 * 强制更新时(includeFresh)用户已经确认,新的锁也一起删。
 */
export async function cleanupLockFiles(gitDir, branch, { includeFresh = false } = {}) {
    const candidates = [...LOCK_FILES];
    if (branch) {
        candidates.push(`refs/heads/${branch}.lock`, `refs/remotes/origin/${branch}.lock`);
    }
    const removed = [];
    const fresh = [];
    for (const name of candidates) {
        const file = path.join(gitDir, name);
        let stat;
        try {
            stat = await fsp.stat(file);
        } catch {
            continue;
        }
        if (!includeFresh && Date.now() - stat.mtimeMs < STALE_LOCK_MS) {
            fresh.push(name);
            continue;
        }
        try {
            await fsp.rm(file, { force: true });
            removed.push(name);
        } catch {
            fresh.push(name);
        }
    }
    return { removed, fresh };
}

export function samePath(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
