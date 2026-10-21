import { redactUrl } from './util.js';

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

/**
 * 解析扩展的远端地址。镜像地址(前缀镜像、域名镜像)会被认出来并还原成 GitHub 原地址,
 * 这样已经用镜像装好的扩展在更新时也能自由切换线路。
 */
export function parseRemoteUrl(raw, { domainMirrors = [] } = {}) {
    const text = String(raw ?? '').trim();
    const info = {
        raw: text,
        isHttp: false,
        hasCredentials: false,
        host: '',
        github: null,
        mirror: null,
        canonical: text,
        display: redactUrl(text),
        cacheHost: '',
    };
    if (!text) {
        return info;
    }

    let url;
    try {
        url = new URL(text);
    } catch {
        return info;
    }

    info.host = url.hostname.toLowerCase();
    info.cacheHost = info.host;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return info;
    }

    info.isHttp = true;
    info.hasCredentials = Boolean(url.username || url.password);

    if (GITHUB_HOSTS.has(info.host)) {
        const github = parseGithubPath(url.pathname);
        if (github) {
            info.github = github;
            info.cacheHost = 'github.com';
        }
        return info;
    }

    // 有的反代会把 "https://" 合并成 "https:/",所以斜杠数量放宽
    const prefixMatch = /^\/+((?:https?:\/+)?(?:www\.)?github\.com\/.*)$/i.exec(url.pathname);
    if (prefixMatch) {
        const inner = prefixMatch[1].replace(/^https?:\/+/i, '').replace(/^(www\.)?github\.com/i, '');
        const github = parseGithubPath(inner);
        if (github) {
            info.github = github;
            info.mirror = { kind: 'prefix', base: `${url.origin}/` };
            info.canonical = toGithubUrl(github);
            info.cacheHost = 'github.com';
            return info;
        }
    }

    const knownDomainMirrors = new Set(domainMirrors.map(host => String(host).toLowerCase()));
    if (knownDomainMirrors.has(info.host)) {
        const github = parseGithubPath(url.pathname);
        if (github) {
            info.github = github;
            info.mirror = { kind: 'domain', host: info.host };
            info.canonical = toGithubUrl(github);
            info.cacheHost = 'github.com';
        }
    }

    return info;
}

function parseGithubPath(pathname) {
    const parts = String(pathname ?? '').split('/').filter(Boolean);
    if (parts.length !== 2) {
        return null;
    }
    const owner = parts[0];
    const hasGitSuffix = /\.git$/i.test(parts[1]);
    const repo = parts[1].replace(/\.git$/i, '');
    if (!PATH_SEGMENT.test(owner) || !PATH_SEGMENT.test(repo) || repo === '.' || repo === '..') {
        return null;
    }
    return { owner, repo, hasGitSuffix };
}

export function toGithubUrl(github, { forceGitSuffix = false } = {}) {
    const suffix = forceGitSuffix || github.hasGitSuffix ? '.git' : '';
    return `https://github.com/${github.owner}/${github.repo}${suffix}`;
}

export function normalizeProxyUrl(value) {
    let text = String(value ?? '').trim();
    if (!text) {
        return '';
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        text = `http://${text}`;
    }
    // 只写 socks:// 时,curl 当 socks4、proxy-agent 当 socks5,统一成 socks5h(远程解析域名)。
    text = text.replace(/^socks:\/\//i, 'socks5h://');
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (!PROXY_PROTOCOLS.has(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
        return null;
    }
    return url.toString().replace(/\/$/, '');
}

export function getProxyEndpoint(proxyUrl) {
    const url = new URL(proxyUrl);
    const defaultPort = { 'http:': 80, 'https:': 443 }[url.protocol] ?? 1080;
    return {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port) || defaultPort,
    };
}

export function normalizePrefixMirror(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return null;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
        return null;
    }
    const result = url.toString();
    return result.endsWith('/') ? result : `${result}/`;
}

export function normalizeDomainMirror(value) {
    const host = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || GITHUB_HOSTS.has(host)) {
        return null;
    }
    return host;
}

export function hostLabel(url) {
    try {
        return new URL(url).host;
    } catch {
        return String(url ?? '');
    }
}
