import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ExtensionOpError } from './errors.js';
import { getManagerRoot } from './paths.js';
import { normalizeDomainMirror, normalizePrefixMirror, normalizeProxyUrl } from './remote-url.js';

// 镜像可用性变化很快,这里只是默认值;内置线路全部连不上时还会读云端列表(cloud-mirrors.js)。
export const DEFAULT_PREFIX_MIRRORS = Object.freeze([
    'https://gh-proxy.org/',
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    'https://ghproxy.net/',
    'https://github.moeyy.xyz/',
    'https://hub.gitmirror.com/',
]);
export const DEFAULT_DOMAIN_MIRRORS = Object.freeze(['kkgithub.com', 'bgithub.xyz']);
export const DEFAULT_LOCAL_PROXY_PORTS = Object.freeze([7890, 7897, 10809, 1080]);

const MAX_MIRRORS = 20;
const MAX_PORTS = 10;

let cache = null;

export function getConfigPath() {
    return path.join(getManagerRoot(), 'config.json');
}

export function getDefaultConfig() {
    return normalizeConfig({});
}

export function loadConfig() {
    let file;
    try {
        file = getConfigPath();
    } catch {
        return getDefaultConfig();
    }

    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
        mtimeMs = 0;
    }
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) {
        return cache.config;
    }

    let raw = {};
    if (mtimeMs) {
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            console.warn('[BaiBaoKu] 扩展管理配置读取失败,使用默认值:', error?.message ?? error);
        }
    }
    const config = normalizeConfig(raw);
    cache = { file, mtimeMs, config };
    return config;
}

export function saveConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ExtensionOpError('INVALID_CONFIG', '配置格式不对。', { status: 400 });
    }
    const current = loadConfig();
    const next = normalizeConfig({ ...current, ...patch }, { strict: true });
    // 和默认值相同的项不写进文件,以后默认镜像列表更新时能自动跟上
    const defaults = getDefaultConfig();
    const stored = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key])));
    const file = getConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, `${JSON.stringify(stored, null, 4)}\n`);
    cache = null;
    return loadConfig();
}

export function normalizeConfig(input, { strict = false } = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const fail = message => {
        throw new ExtensionOpError('INVALID_CONFIG', message, { status: 400 });
    };

    let proxy = normalizeProxyUrl(source.proxy);
    if (proxy === null) {
        if (strict) fail(`代理地址格式不对:${source.proxy}(示例:http://127.0.0.1:7890 或 socks5://127.0.0.1:1080)`);
        proxy = '';
    }

    return {
        interceptEnabled: source.interceptEnabled !== false,
        proxy,
        autoDetectProxy: source.autoDetectProxy !== false,
        localProxyPorts: normalizePorts(source.localProxyPorts, strict ? fail : null),
        prefixMirrors: normalizeList(source.prefixMirrors, DEFAULT_PREFIX_MIRRORS, normalizePrefixMirror, '镜像地址', strict ? fail : null),
        domainMirrors: normalizeList(source.domainMirrors, DEFAULT_DOMAIN_MIRRORS, normalizeDomainMirror, '镜像域名', strict ? fail : null),
        probeTimeoutMs: clampInteger(source.probeTimeoutMs, 2000, 30000, 8000),
        operationTimeoutMs: clampInteger(source.operationTimeoutMs, 30000, 30 * 60000, 5 * 60000),
    };
}

function normalizeList(value, defaults, normalizeItem, label, fail) {
    if (!Array.isArray(value)) {
        return [...defaults];
    }
    const result = [];
    for (const item of value) {
        const normalized = normalizeItem(item);
        if (!normalized) {
            if (fail) fail(`${label}格式不对:${item}`);
            continue;
        }
        if (!result.includes(normalized)) {
            result.push(normalized);
        }
    }
    if (result.length > MAX_MIRRORS) {
        if (fail) fail(`${label}最多 ${MAX_MIRRORS} 个。`);
        result.length = MAX_MIRRORS;
    }
    return result;
}

function normalizePorts(value, fail) {
    if (!Array.isArray(value)) {
        return [...DEFAULT_LOCAL_PROXY_PORTS];
    }
    const ports = [];
    for (const item of value) {
        const port = Number(item);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            if (fail) fail(`端口不对:${item}`);
            continue;
        }
        if (!ports.includes(port)) {
            ports.push(port);
        }
    }
    return ports.slice(0, MAX_PORTS);
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
}
