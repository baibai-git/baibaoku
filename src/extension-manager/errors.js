import { BaiBaoKuError } from '../errors.js';
import { lastMeaningfulLine } from './util.js';

export class ExtensionOpError extends BaiBaoKuError {
    constructor(code, message, { status = 500, stage = null, hint = null, details = undefined, cause = undefined } = {}) {
        super(code, message, status, details);
        this.name = 'ExtensionOpError';
        this.stage = stage;
        this.hint = hint;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

// 顺序有讲究:代理相关的超时要先归到 proxy,"not found" 要排在认证之后(GitHub 私有仓库也回 not found)。
const FAILURE_RULES = [
    { kind: 'dns', text: '域名解析失败', pattern: /could not resolve (host|proxy)|name or service not known|getaddrinfo|enotfound|no such host|temporary failure in name resolution/i },
    { kind: 'proxy', text: '代理连接失败', pattern: /proxy|socks/i },
    { kind: 'timeout', text: '连接超时', pattern: /timed out|timeout|operation too slow|etimedout/i },
    { kind: 'tls', text: 'TLS/证书错误', pattern: /ssl|tls|certificate|gnutls|schannel/i },
    { kind: 'auth', text: '需要登录凭据(私有仓库或地址写错)', pattern: /could not read (username|password)|authentication failed|terminal prompts disabled|cannot prompt because|invalid username or password|returned error: 40[13]|\b40[13]\b.*(forbidden|unauthorized)/i },
    { kind: 'not-found', text: '仓库不存在,或这条线路不支持', pattern: /repository not found|not found|returned error: 404|does not appear to be a git repository|\b404\b/i },
    { kind: 'connect', text: '连接失败', pattern: /failed to connect|connection refused|couldn't connect|connection reset|econnrefused|econnreset|network is unreachable|empty reply from server|recv failure|connection was reset|socket hang up/i },
    { kind: 'transfer', text: '下载中途断开', pattern: /early eof|rpc failed|unexpected disconnect|remote end hung up|fetch-pack|index-pack|transfer closed|unexpected end|premature end/i },
    { kind: 'http', text: 'HTTP 错误', pattern: /returned error: \d{3}|http \d{3}|status code \d{3}/i },
];

export function classifyGitFailure(stderr, { timedOut = false, aborted = false } = {}) {
    const detail = lastMeaningfulLine(stderr);
    if (aborted) {
        return { kind: 'aborted', summary: '已取消', detail };
    }
    if (timedOut) {
        return { kind: 'timeout', summary: '连接超时', detail };
    }
    const text = String(stderr ?? '');
    const rule = FAILURE_RULES.find(item => item.pattern.test(text));
    if (rule) {
        return { kind: rule.kind, summary: rule.text, detail };
    }
    return { kind: 'unknown', summary: detail || '未知错误', detail };
}
