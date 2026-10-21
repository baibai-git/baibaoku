import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sanitize from 'sanitize-filename';
import { PUBLIC_DIRECTORIES } from '../../../../src/constants.js';
import { ExtensionOpError } from './errors.js';

export const RESERVED_PREFIX = '.baibaoku-';
export const STAGING_DIRNAME = `${RESERVED_PREFIX}staging`;

export function getManagerRoot() {
    const dataRoot = globalThis.DATA_ROOT;
    if (!dataRoot) {
        throw new ExtensionOpError('DATA_ROOT_MISSING', '酒馆数据目录还没有初始化。', { status: 500 });
    }
    return path.join(path.resolve(dataRoot), '_baibaoku', 'extension-manager');
}

export function getTrashRoot() {
    return path.join(getManagerRoot(), 'trash');
}

export function getBackupRoot() {
    return path.join(getManagerRoot(), 'backups');
}

export function getGlobalExtensionsBase() {
    return path.resolve(PUBLIC_DIRECTORIES.globalExtensions);
}

export function isAdmin(req) {
    return Boolean(req?.user?.profile?.admin);
}

export function getUserHandle(req) {
    return String(req?.user?.profile?.handle ?? '');
}

export function getUserExtensionsBase(req) {
    const directory = req?.user?.directories?.extensions;
    if (!directory) {
        throw new ExtensionOpError('USER_DIRECTORY_MISSING', '找不到当前用户的扩展目录。', { status: 500 });
    }
    return path.resolve(directory);
}

// 和原生接口一致:全局扩展的安装/更新/删除只有管理员能做,检查版本(write: false)谁都可以
export function getExtensionsBase(req, global, { write = true } = {}) {
    if (!global) {
        return getUserExtensionsBase(req);
    }
    if (write && !isAdmin(req)) {
        throw new ExtensionOpError('FORBIDDEN', '只有管理员可以安装、更新或删除全局扩展。', { status: 403, stage: 'validate' });
    }
    return getGlobalExtensionsBase();
}

// 酒馆前端传的是 "/名称"(把 third-party 去掉后的样子),原生接口直接 sanitize;这里多兼容几种写法。
export function normalizeFolderName(value) {
    const name = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^third-party\//i, '');
    const folder = sanitize(name);
    if (!folder || folder === '.' || folder === '..' || folder.toLowerCase().startsWith(RESERVED_PREFIX)) {
        return '';
    }
    return folder;
}

export function resolveExtensionTarget(req, body, { write = true } = {}) {
    const global = Boolean(body?.global);
    const folder = typeof body?.extensionName === 'string' ? normalizeFolderName(body.extensionName) : '';
    if (!folder) {
        throw new ExtensionOpError('INVALID_NAME', '缺少扩展名称。', { status: 400, stage: 'validate' });
    }
    const base = getExtensionsBase(req, global, { write });
    const dir = path.join(base, folder);
    assertInside(base, dir);
    return { global, folder, base, dir };
}

export function assertInside(parent, child) {
    const relative = path.relative(parent, child);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ExtensionOpError('INVALID_PATH', '扩展路径不合法。', { status: 400 });
    }
}

export function makeLockKey(dir) {
    const resolved = path.resolve(dir);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function listUserExtensionBases() {
    const dataRoot = globalThis.DATA_ROOT;
    if (!dataRoot) {
        return [];
    }
    let entries = [];
    try {
        entries = fs.readdirSync(dataRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map(entry => path.join(path.resolve(dataRoot), entry.name, 'extensions'))
        .filter(directory => fs.existsSync(directory));
}
