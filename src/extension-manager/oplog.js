import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getManagerRoot } from './paths.js';
import { redactUrl } from './util.js';

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 60;

const entries = [];
let writeChain = Promise.resolve();

function getLogFile() {
    return path.join(getManagerRoot(), 'ops.jsonl');
}

export function createOpId() {
    return `op_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 一次扩展操作的记录:每条线路的尝试、阶段、结果。失败时前端凭 opId 拉详情做诊断。
 */
export class OpRecorder {
    constructor({ kind, user, extension, global = false, backend = null, gitVersion = null, source = '' }) {
        this.started = Date.now();
        this.entry = {
            id: createOpId(),
            kind,
            user,
            extension,
            global: Boolean(global),
            startedAt: new Date(this.started).toISOString(),
            finishedAt: null,
            elapsedMs: 0,
            ok: null,
            code: null,
            message: '',
            hint: null,
            stage: 'start',
            backend,
            gitVersion,
            source: redactUrl(source),
            attempts: [],
            result: null,
            details: {},
        };
        this.finished = false;
    }

    get id() {
        return this.entry.id;
    }

    setStage(stage) {
        this.entry.stage = stage;
    }

    setSource(source) {
        this.entry.source = redactUrl(source);
    }

    addAttempt({ label, kind, phase, ok, latencyMs = 0, error = null, sha = null }) {
        if (this.entry.attempts.length >= MAX_ATTEMPTS) return;
        this.entry.attempts.push({
            label,
            kind,
            phase,
            ok: Boolean(ok),
            latencyMs: Math.round(latencyMs),
            sha: sha ? String(sha).slice(0, 12) : null,
            error: error ? { kind: error.kind, summary: error.summary, detail: redactUrl(error.detail ?? '') } : null,
        });
    }

    addProbeResult(result, phase = 'probe') {
        const refs = result.refs;
        this.addAttempt({
            label: result.route.label,
            kind: result.route.kind,
            phase,
            ok: result.ok,
            latencyMs: result.latencyMs,
            error: result.ok ? null : result.failure,
            sha: refs ? refs.branchSha ?? refs.defaultSha : null,
        });
    }

    setDetail(key, value) {
        this.entry.details[key] = value;
    }

    finish({ ok, code = null, message = '', hint = null, result = null, record = true }) {
        if (this.finished) return this.entry;
        this.finished = true;
        Object.assign(this.entry, {
            ok: Boolean(ok),
            code,
            message: redactUrl(message),
            hint,
            result,
            finishedAt: new Date().toISOString(),
            elapsedMs: Date.now() - this.started,
        });
        if (record) {
            recordOp(this.entry);
        }
        return this.entry;
    }
}

export function recordOp(entry) {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
    }
    const line = `${JSON.stringify(entry)}\n`;
    writeChain = writeChain.then(() => appendLine(line)).catch(() => {});
}

async function appendLine(line) {
    let file;
    try {
        file = getLogFile();
    } catch {
        return;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, line, 'utf8');
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > MAX_FILE_BYTES) {
        const text = entries.map(item => JSON.stringify(item)).join('\n');
        await fsp.writeFile(`${file}.tmp`, `${text}\n`, 'utf8');
        await fsp.rename(`${file}.tmp`, file);
    }
}

export function loadOps() {
    let text = '';
    try {
        text = fs.readFileSync(getLogFile(), 'utf8');
    } catch {
        return;
    }
    const loaded = [];
    for (const line of text.split(/\r?\n/).slice(-MAX_ENTRIES - 1)) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry && typeof entry.id === 'string') loaded.push(entry);
        } catch {
            // 半行(写入时被中断)直接跳过
        }
    }
    entries.splice(0, entries.length, ...loaded.slice(-MAX_ENTRIES));
}

function canSee(entry, { user, admin }) {
    return admin || entry.user === user;
}

export function listOps({ user, admin, limit = 50, kind = null, failedOnly = false }) {
    return entries
        .filter(entry => canSee(entry, { user, admin }) && (!kind || entry.kind === kind) && (!failedOnly || entry.ok === false))
        .slice(-Math.max(1, Math.min(MAX_ENTRIES, limit)))
        .reverse()
        .map(({ attempts, details, result, ...summary }) => ({ ...summary, attemptCount: attempts?.length ?? 0 }));
}

export function getOp(id, { user, admin }) {
    const entry = entries.find(item => item.id === id);
    return entry && canSee(entry, { user, admin }) ? entry : null;
}

export async function flushOps() {
    await writeChain;
}

export function resetOps() {
    entries.length = 0;
}
