import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getBackupRoot, getTrashRoot, STAGING_DIRNAME } from './paths.js';
import { delay, timestampSlug } from './util.js';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const RENAME_ATTEMPTS = 6;
const KEEP_TRASH_MS = 7 * 24 * 60 * 60_000;

export async function pathExists(target) {
    try {
        await fsp.lstat(target);
        return true;
    } catch {
        return false;
    }
}

// Windows 上杀毒软件/索引服务/编辑器经常短暂占用文件,rename 要带退避重试。
export async function renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
        try {
            await fsp.rename(from, to);
            return;
        } catch (error) {
            lastError = error;
            if (!RETRYABLE_RENAME_CODES.has(error?.code)) {
                throw error;
            }
            await delay(100 * 2 ** attempt);
        }
    }
    throw lastError;
}

export async function removePath(target) {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}

/**
 * 移动目录。同一磁盘直接 rename(原子);跨磁盘(Docker 挂载卷常见)先复制再删源目录。
 * 删源目录时先删 manifest.json,这样就算后面删不干净,酒馆也不会把半个扩展当成已安装。
 */
export async function moveDir(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
        await renameWithRetry(from, to);
        return { method: 'rename', leftover: false };
    } catch (error) {
        if (error?.code !== 'EXDEV') {
            throw error;
        }
    }
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const removal = await removeExtensionDir(from);
    return { method: 'copy', leftover: removal.leftover };
}

export async function removeExtensionDir(dir) {
    const stat = await fsp.lstat(dir).catch(() => null);
    if (stat?.isSymbolicLink()) {
        // 链接进来的扩展只删链接本身,绝不能动链接指向的源码目录
        await removePath(dir);
        return { leftover: false };
    }
    await fsp.rm(path.join(dir, 'manifest.json'), { force: true, maxRetries: 6, retryDelay: 200 });
    try {
        await removePath(dir);
        return { leftover: false };
    } catch (error) {
        return { leftover: true, error };
    }
}

export async function moveToTrash(dir, meta = {}) {
    const id = `${timestampSlug()}-${crypto.randomBytes(3).toString('hex')}`;
    const container = path.join(getTrashRoot(), id);
    const target = path.join(container, path.basename(dir));
    await fsp.mkdir(container, { recursive: true });
    let moved;
    try {
        moved = await moveDir(dir, target);
    } catch (error) {
        await fsp.rm(container, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
    const info = { ...meta, originalPath: dir, trashedAt: new Date().toISOString(), method: moved.method };
    await fsp.writeFile(path.join(container, 'trash.json'), `${JSON.stringify(info, null, 2)}\n`).catch(() => {});
    return { trashPath: target, method: moved.method, leftover: moved.leftover };
}

export async function backupDir(dir, label) {
    const target = path.join(getBackupRoot(), `${timestampSlug()}-${crypto.randomBytes(3).toString('hex')}`, label || path.basename(dir));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // 扩展目录本身是链接时要备份链接指向的内容,只复制链接等于没备份
    const source = await fsp.realpath(dir).catch(() => dir);
    await fsp.cp(source, target, { recursive: true, verbatimSymlinks: true });
    return target;
}

// 只备份改动过的文件(普通更新前用),更新失败需要回退时再放回去
export async function backupFiles(dir, files, label) {
    const root = path.join(getBackupRoot(), `${timestampSlug()}-${crypto.randomBytes(3).toString('hex')}`, label || path.basename(dir));
    const saved = [];
    for (const file of files) {
        const from = path.resolve(dir, file);
        const relative = path.relative(dir, from);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        try {
            await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
            await fsp.copyFile(from, path.join(root, relative));
            saved.push(relative);
        } catch {
            // 本地删掉的文件没法备份,回退时它会按更新前的版本恢复
        }
    }
    return { root, files: saved };
}

export async function restoreFiles(backup, dir) {
    const failed = [];
    for (const file of backup.files) {
        try {
            await fsp.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
            await fsp.copyFile(path.join(backup.root, file), path.join(dir, file));
        } catch {
            failed.push(file);
        }
    }
    return failed;
}

export async function pruneOldEntries(root, maxAgeMs = KEEP_TRASH_MS) {
    let entries = [];
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
        return 0;
    }
    let removed = 0;
    for (const entry of entries) {
        const target = path.join(root, entry.name);
        try {
            const stat = await fsp.stat(target);
            if (Date.now() - stat.mtimeMs > maxAgeMs) {
                await removePath(target);
                removed++;
            }
        } catch {
            // 删不掉就下次再试
        }
    }
    return removed;
}

// 启动时没有任何任务在跑,扩展目录里的临时目录都是上次中断留下的,可以全部清掉。
export async function sweepStagingDir(base) {
    const staging = path.join(base, STAGING_DIRNAME);
    if (!(await pathExists(staging))) {
        return false;
    }
    try {
        await removePath(staging);
        return true;
    } catch {
        return false;
    }
}

export async function sweepManagerDirs() {
    const trash = await pruneOldEntries(getTrashRoot());
    const backups = await pruneOldEntries(getBackupRoot());
    return { trash, backups };
}
