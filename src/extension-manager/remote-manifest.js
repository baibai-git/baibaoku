import http from 'node:http';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { anySignal } from './util.js';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const CACHE_LIMIT = 300;
const USER_AGENT = 'baibaoku-extension-manager';

// 同一个提交的 manifest 不会变,按 sha 缓存
const cache = new Map();

/**
 * 读取远端某个提交的 manifest.json(用来显示"新版本号")。
 * 优先走版本检查时已经验证可用的线路;都不行再试 jsDelivr。失败返回 null,不影响版本检查本身。
 */
export async function fetchRemoteManifest({ remote, sha, routes = [], signal }) {
    if (!remote?.github || !/^[0-9a-f]{40,64}$/i.test(String(sha ?? ''))) {
        return null;
    }
    const { owner, repo } = remote.github;
    const key = `${owner}/${repo}@${sha}`.toLowerCase();
    if (cache.has(key)) {
        return cache.get(key);
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/manifest.json`;
    const candidates = [];
    for (const route of routes) {
        if (route.kind === 'direct' && !route.sshLike) {
            candidates.push({ url: rawUrl, proxy: '' });
        } else if (route.kind === 'proxy') {
            candidates.push({ url: rawUrl, proxy: route.proxy });
        } else if (route.prefix) {
            candidates.push({ url: `${route.prefix}${rawUrl}`, proxy: '' });
        }
    }
    candidates.push({ url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${sha}/manifest.json`, proxy: '' });

    const seen = new Set();
    for (const candidate of candidates) {
        const id = `${candidate.proxy}|${candidate.url}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 3 || signal?.aborted) break;
        try {
            const manifest = pickManifestFields(await getJson(candidate, signal));
            remember(key, manifest);
            return manifest;
        } catch {
            // 换下一个
        }
    }
    return null;
}

function remember(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) {
        cache.delete(cache.keys().next().value);
    }
}

function pickManifestFields(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('manifest is not an object');
    }
    const text = value => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : null);
    return {
        display_name: text(manifest.display_name),
        version: text(manifest.version),
        author: text(manifest.author),
        homePage: text(manifest.homePage),
    };
}

async function getJson({ url, proxy }, signal) {
    const agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : null;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = anySignal([signal, timeout]);
    try {
        let target = new URL(url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const response = await request(target, agent, combined);
            if (response.status >= 300 && response.status < 400 && response.location) {
                target = new URL(response.location, target);
                continue;
            }
            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}`);
            }
            return JSON.parse(response.body.replace(/^\uFEFF/, ''));
        }
        throw new Error('too many redirects');
    } finally {
        agent?.destroy?.();
    }
}

function request(url, agent, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            reject(new Error(`unsupported protocol ${url.protocol}`));
            return;
        }
        const transport = url.protocol === 'http:' ? http : https;
        // 直连时显式用新的 agent,不受酒馆 requestProxy 替换的全局 agent 影响
        const req = transport.request(url, {
            method: 'GET',
            headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain, */*' },
            agent: agent ?? new transport.Agent({ keepAlive: false }),
            signal,
        });
        req.once('error', reject);
        req.once('response', res => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                resolve({ status: res.statusCode, location: res.headers.location, body: '' });
                return;
            }
            let size = 0;
            const chunks = [];
            res.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    req.destroy(new Error('manifest too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.once('error', reject);
            res.once('end', () => resolve({ status: res.statusCode, location: null, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.end();
    });
}
