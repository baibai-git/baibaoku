import { normalizeDomainMirror, normalizePrefixMirror } from './remote-url.js';

// 内置线路(直连、代理、内置镜像)全部连不上时才读的云端镜像列表,纯文本一行一个:
// https:// 开头的是前缀镜像(加在 GitHub 地址前面),不带协议的域名是域名镜像(替换 github.com),# 后面是注释。
// 留空表示不用云端列表。
export const CLOUD_MIRROR_LIST_URL = 'https://img.baibai.cv/f/6pLAhA/%E6%9F%8F%E5%AE%9D%E5%BA%93%E9%95%9C%E5%83%8F%E5%88%97%E8%A1%A8.txt';

const SUCCESS_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_ENTRIES = 20;

let listUrl = CLOUD_MIRROR_LIST_URL;
let cache = null;
let pending = null;

export function parseMirrorList(text) {
    const prefixMirrors = [];
    const domainMirrors = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        // trim 会顺带去掉记事本保存时加的 BOM
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (line.includes('://')) {
            const prefix = normalizePrefixMirror(line);
            if (prefix && !prefixMirrors.includes(prefix)) prefixMirrors.push(prefix);
        } else {
            const host = normalizeDomainMirror(line);
            if (host && !domainMirrors.includes(host)) domainMirrors.push(host);
        }
    }
    return { prefixMirrors: prefixMirrors.slice(0, MAX_ENTRIES), domainMirrors: domainMirrors.slice(0, MAX_ENTRIES) };
}

/**
 * 读云端镜像列表:成功缓存 30 分钟、失败缓存 5 分钟,同时只发一个请求;force 用于手动测试线路。
 * 没配置地址时返回 null。
 */
export async function getCloudMirrors({ force = false } = {}) {
    const url = listUrl;
    if (!url) {
        return null;
    }
    if (!force && cache?.url === url && Date.now() - cache.at < (cache.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
        return cache;
    }
    if (!pending) {
        pending = fetchCloudMirrors(url)
            .then(result => {
                cache = result;
                return result;
            })
            .finally(() => {
                pending = null;
            });
    }
    return pending;
}

// 测试用:换列表地址,顺带清掉缓存
export function setCloudMirrorListUrl(url) {
    listUrl = String(url ?? '');
    cache = null;
}

async function fetchCloudMirrors(url) {
    const at = Date.now();
    try {
        const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = (await response.text()).slice(0, MAX_TEXT_LENGTH);
        return { ok: true, url, at, error: null, ...parseMirrorList(text) };
    } catch (error) {
        return { ok: false, url, at, error: describeFetchError(error), prefixMirrors: [], domainMirrors: [] };
    }
}

function describeFetchError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return '读取超时';
    }
    return String(error?.cause?.code || error?.cause?.message || error?.message || error);
}
