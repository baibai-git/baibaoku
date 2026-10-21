export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 去掉 URL 里的用户名/密码/token,日志和返回给前端的内容都要过一遍。
export function redactUrl(value) {
    return String(value ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}

export function tailText(value, maxLength = 1200) {
    const text = redactUrl(String(value ?? '')).trim();
    return text.length > maxLength ? `…${text.slice(-maxLength)}` : text;
}

export function lastMeaningfulLine(stderr) {
    const lines = String(stderr ?? '')
        .split(/\r?\n|\r/)
        .map(line => line.trim())
        .filter(line => line && !isProgressLine(line));
    const important = [...lines].reverse().find(line => /^(fatal|error):/i.test(line));
    return redactUrl(important || lines.at(-1) || '').slice(0, 240);
}

export function isProgressLine(line) {
    return /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Updating|Unpacking|Checking out|Total)\b/i.test(line)
        || /^remote:\s*$/i.test(line);
}

export function timestampSlug(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function shortSha(sha) {
    return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

export function anySignal(signals) {
    const list = signals.filter(Boolean);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return AbortSignal.any(list);
}

export function formatList(items, limit = 5) {
    const list = items.slice(0, limit).join('、');
    return items.length > limit ? `${list} 等 ${items.length} 个` : list;
}
