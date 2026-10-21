import net from 'node:net';
import os from 'node:os';
import process from 'node:process';
import { getConfigValue } from '../../../../src/util.js';
import { detectSystemGit, runGit } from './git-runner.js';
import { getProxyEndpoint, normalizeProxyUrl } from './remote-url.js';
import { redactUrl } from './util.js';

const DETECT_TTL_MS = 60_000;
const TCP_CHECK_TIMEOUT_MS = 800;
const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
const SOURCE_LABELS = {
    config: '柏宝库配置里的代理',
    env: '环境变量',
    'st-request-proxy': '酒馆 requestProxy',
    'git-config': 'git 全局配置',
    'local-port': '本机常见代理端口',
};

export const EMPTY_PROXY_INFO = Object.freeze({ candidates: [], alive: [], gitProxyKeys: [], detectedAt: 0 });

let detection = null;

/**
 * 收集可能的代理:柏宝库配置、环境变量、酒馆 requestProxy、git 全局 http.proxy、本机常见端口。
 * 每个都先做一次 TCP 连通性检查,连不上的不参与线路选择(git 全局配置里的死代理正是常见故障源)。
 */
export function detectProxies(config, { force = false } = {}) {
    const key = JSON.stringify([config.proxy, config.autoDetectProxy, config.localProxyPorts]);
    if (!force && detection && detection.key === key && Date.now() - detection.at < DETECT_TTL_MS) {
        return detection.promise;
    }
    const promise = runDetection(config).catch(error => {
        console.warn('[BaiBaoKu] 代理检测失败:', error?.message ?? error);
        return EMPTY_PROXY_INFO;
    });
    detection = { key, at: Date.now(), promise };
    return promise;
}

export function getCachedProxyInfo() {
    return detection?.promise ?? null;
}

async function runDetection(config) {
    const found = new Map();
    const add = (value, source, detail = '') => {
        const url = normalizeProxyUrl(value);
        if (!url) return;
        const existing = found.get(url);
        if (existing) {
            existing.sources.push({ source, detail });
        } else {
            found.set(url, { url, sources: [{ source, detail }] });
        }
    };

    if (config.proxy) {
        add(config.proxy, 'config');
    }
    for (const key of ENV_KEYS) {
        if (process.env[key]) add(process.env[key], 'env', key);
    }
    const stProxy = readStRequestProxy();
    if (stProxy) {
        add(stProxy, 'st-request-proxy');
    }
    const gitProxy = await readGitProxyConfig();
    for (const entry of gitProxy.entries) {
        add(entry.value, 'git-config', entry.key);
    }
    const localCandidates = new Set();
    if (config.autoDetectProxy) {
        for (const port of config.localProxyPorts) {
            const url = `${port === 1080 ? 'socks5h' : 'http'}://127.0.0.1:${port}`;
            if (!found.has(url)) localCandidates.add(url);
            add(url, 'local-port');
        }
    }

    const candidates = [...found.values()];
    await Promise.all(candidates.map(async candidate => {
        candidate.alive = await isProxyReachable(candidate.url);
    }));

    return {
        // 自动探测的端口连不上就不显示,免得一堆无关的"不可用"
        candidates: candidates.filter(candidate => candidate.alive || !localCandidates.has(candidate.url)),
        alive: candidates.filter(candidate => candidate.alive),
        gitProxyKeys: gitProxy.keys,
        detectedAt: Date.now(),
    };
}

function readStRequestProxy() {
    try {
        if (!getConfigValue('requestProxy.enabled', false, 'boolean')) {
            return '';
        }
        return String(getConfigValue('requestProxy.url', '') ?? '');
    } catch {
        return '';
    }
}

async function readGitProxyConfig() {
    const result = { entries: [], keys: [] };
    if (!(await detectSystemGit())) {
        return result;
    }
    for (const scope of ['--system', '--global']) {
        const output = await runGit(['config', scope, '--get-regexp', '^https?\\..*proxy$'], { cwd: os.tmpdir(), timeoutMs: 8000 });
        if (output.code !== 0) continue;
        for (const line of output.stdout.split(/\r?\n/)) {
            const match = /^(\S+)\s+(.+)$/.exec(line.trim());
            if (!match || !/^https?\.(.+\.)?proxy$/i.test(match[1])) continue;
            result.entries.push({ key: match[1], value: match[2].trim() });
            // https.proxy 不是 git 的配置项,只当候选代理;http.proxy / http.<url>.proxy 需要在每次命令里覆盖掉
            if (/^http\./i.test(match[1]) && !result.keys.includes(match[1])) {
                result.keys.push(match[1]);
            }
        }
    }
    return result;
}

export function isProxyReachable(proxyUrl, timeoutMs = TCP_CHECK_TIMEOUT_MS) {
    let endpoint;
    try {
        endpoint = getProxyEndpoint(proxyUrl);
    } catch {
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        const socket = net.connect({ host: endpoint.host, port: endpoint.port });
        const done = value => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

export function describeProxy(candidate, { reveal = false } = {}) {
    return {
        url: reveal ? candidate.url : redactUrl(candidate.url),
        alive: Boolean(candidate.alive),
        sources: candidate.sources.map(item => SOURCE_LABELS[item.source] + (item.detail ? `(${item.detail})` : '')),
    };
}
