import http from 'node:http';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 30000;
const USER_AGENT = 'git/isomorphic-git (baibaoku)';

/**
 * 给 isomorphic-git 用的 http 客户端。
 * 每条线路显式指定 agent:直连时不能用全局 agent(酒馆开了 requestProxy 会把全局 agent 换成代理),
 * 走代理时只用这条线路自己的代理。支持取消、空闲超时,并自己处理跳转。
 */
export function createGitHttpClient({ proxy = '', signal } = {}) {
    const agents = proxy
        ? { proxy: new ProxyAgent({ getProxyForUrl: () => proxy }) }
        : { http: new http.Agent(), https: new https.Agent() };
    const active = new Set();
    // info/refs 被跳转到新地址时(仓库改名、镜像换域名),后续的 POST 也要发到新地址,和 git 的行为一致
    let rewrite = null;

    const pickAgent = url => agents.proxy ?? (url.protocol === 'http:' ? agents.http : agents.https);

    const abortAll = () => {
        const error = new Error('aborted');
        error.code = 'ABORT_ERR';
        for (const item of active) {
            item.destroy(error);
        }
    };
    signal?.addEventListener('abort', abortAll, { once: true });

    function send(url, method, headers, body) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
                return;
            }
            const transport = url.protocol === 'http:' ? http : https;
            const requestHeaders = { 'user-agent': USER_AGENT, ...headers };
            if (body) {
                requestHeaders['content-length'] = String(body.length);
            }
            const req = transport.request(url, { method, headers: requestHeaders, agent: pickAgent(url) });
            active.add(req);
            req.setTimeout(IDLE_TIMEOUT_MS, () => {
                req.destroy(Object.assign(new Error(`connection timed out after ${IDLE_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' }));
            });
            req.once('error', error => {
                active.delete(req);
                reject(error);
            });
            req.once('response', res => {
                active.delete(req);
                active.add(res);
                res.setTimeout?.(IDLE_TIMEOUT_MS, () => {
                    res.destroy(Object.assign(new Error(`transfer stalled for ${IDLE_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' }));
                });
                res.once('close', () => active.delete(res));
                resolve(res);
            });
            req.end(body ?? undefined);
        });
    }

    async function request({ url, method = 'GET', headers = {}, body }) {
        const payload = body ? await collectBody(body) : null;
        let target = applyRewrite(url);
        let currentMethod = method;
        let currentBody = payload;

        for (let hop = 0; ; hop++) {
            const res = await send(target, currentMethod, headers, currentBody);
            const location = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && location) {
                res.resume();
                if (hop >= MAX_REDIRECTS) {
                    throw new Error(`too many redirects (${MAX_REDIRECTS})`);
                }
                const next = new URL(location, target);
                if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                    throw new Error(`unsupported redirect to ${next.protocol}`);
                }
                if (res.statusCode === 303) {
                    currentMethod = 'GET';
                    currentBody = null;
                }
                rememberRewrite(target, next);
                target = next;
                continue;
            }
            return {
                url: target.toString(),
                method: currentMethod,
                statusCode: res.statusCode,
                statusMessage: res.statusMessage,
                headers: res.headers,
                body: res,
            };
        }
    }

    function applyRewrite(raw) {
        const url = new URL(raw);
        if (rewrite && url.toString().startsWith(rewrite.from)) {
            return new URL(rewrite.to + url.toString().slice(rewrite.from.length));
        }
        return url;
    }

    function rememberRewrite(from, to) {
        const marker = '/info/refs';
        const fromText = from.toString();
        const toText = to.toString();
        const fromIndex = fromText.indexOf(marker);
        const toIndex = toText.indexOf(marker);
        if (fromIndex > 0 && toIndex > 0 && !rewrite) {
            rewrite = { from: fromText.slice(0, fromIndex), to: toText.slice(0, toIndex) };
        }
    }

    function destroy() {
        signal?.removeEventListener('abort', abortAll);
        for (const item of active) {
            item.destroy();
        }
        active.clear();
        for (const agent of Object.values(agents)) {
            agent.destroy?.();
        }
    }

    return { request, destroy };
}

async function collectBody(body) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        return Buffer.from(body);
    }
    const chunks = [];
    if (Array.isArray(body)) {
        for (const chunk of body) chunks.push(Buffer.from(chunk));
    } else {
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
