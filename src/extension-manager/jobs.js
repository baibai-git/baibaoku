import crypto from 'node:crypto';
import { ExtensionOpError } from './errors.js';

const KEEP_FINISHED_MS = 10 * 60_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const KIND_LABELS = { install: '安装', update: '更新', delete: '删除' };

const jobsById = new Map();
const activeByKey = new Map();

export function isValidClientJobId(value) {
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

class Job {
    constructor({ id, kind, key, signature, user, extension, timeoutMs }) {
        this.id = id;
        this.kind = kind;
        this.key = key;
        this.signature = signature;
        this.user = user;
        this.extension = extension;
        this.createdAt = Date.now();
        this.updatedAt = this.createdAt;
        this.deadline = this.createdAt + timeoutMs;
        this.finishedAt = null;
        this.state = 'running';
        this.stage = 'queued';
        this.message = '';
        this.progress = null;
        this.opId = null;
        this.result = null;
        this.error = null;
        this.controller = new AbortController();
        this.timeoutSignal = AbortSignal.timeout(timeoutMs);
        this.signal = AbortSignal.any([this.controller.signal, this.timeoutSignal]);
        this.promise = null;
    }

    update({ stage, message, progress } = {}) {
        if (this.state !== 'running') return;
        if (stage !== undefined) this.stage = stage;
        if (message !== undefined) this.message = message;
        if (progress !== undefined) this.progress = progress;
        this.updatedAt = Date.now();
    }

    get timedOut() {
        return this.timeoutSignal.aborted;
    }

    toJSON() {
        return {
            id: this.id,
            kind: this.kind,
            extension: this.extension,
            state: this.state,
            stage: this.stage,
            message: this.message,
            progress: this.progress,
            opId: this.opId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            finishedAt: this.finishedAt,
            elapsedMs: (this.finishedAt ?? Date.now()) - this.createdAt,
            result: this.result,
            error: this.error,
        };
    }
}

/**
 * 同一个扩展目录同时只跑一个任务。
 * 相同的请求(比如酒馆前端超时后重试、多个标签页同时自动更新)直接加入正在跑的任务;不同的请求返回 BUSY。
 * 前端带 x-baibaoku-job 头时,10 分钟内用同一个 id 重新请求会拿到同一个任务的结果。
 */
export function runJob({ key, signature, clientId, kind, user, extension, timeoutMs }, executor) {
    pruneFinished();
    if (isValidClientJobId(clientId)) {
        const existing = jobsById.get(clientId);
        if (existing && existing.key === key && existing.signature === signature && existing.user === user) {
            return { job: existing, promise: existing.promise, joined: true };
        }
    }
    const active = activeByKey.get(key);
    if (active) {
        if (active.signature === signature) {
            // 换了个 id 重新请求(前端超时重试、另一个标签页):记成别名,用新 id 也能查到进度
            if (isValidClientJobId(clientId) && !jobsById.has(clientId)) {
                jobsById.set(clientId, active);
            }
            return { job: active, promise: active.promise, joined: true };
        }
        throw new ExtensionOpError('BUSY', `这个扩展正在${KIND_LABELS[active.kind] ?? '处理'},请稍后再试。`, { status: 409, stage: 'queue' });
    }

    const id = isValidClientJobId(clientId) && !jobsById.has(clientId) ? clientId : `job_${crypto.randomBytes(8).toString('hex')}`;
    const job = new Job({ id, kind, key, signature, user, extension, timeoutMs });
    jobsById.set(id, job);
    activeByKey.set(key, job);

    job.promise = (async () => {
        try {
            const result = await executor(job);
            job.state = 'succeeded';
            job.result = summarizeResult(result);
            return result;
        } catch (error) {
            job.state = 'failed';
            job.error = {
                code: error?.code ?? 'INTERNAL_ERROR',
                message: error?.message ?? String(error),
                hint: error?.hint ?? null,
                stage: error?.stage ?? job.stage,
                status: Number.isInteger(error?.status) ? error.status : 500,
            };
            throw error;
        } finally {
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            if (activeByKey.get(key) === job) {
                activeByKey.delete(key);
            }
        }
    })();
    job.promise.catch(() => {});
    return { job, promise: job.promise, joined: false };
}

function summarizeResult(result) {
    if (!result || typeof result !== 'object') return result ?? null;
    const { response, ...rest } = result;
    return { ...rest, response: response ?? null };
}

export function getJob(id) {
    pruneFinished();
    return jobsById.get(id) ?? null;
}

export function listJobs({ user, admin }) {
    pruneFinished();
    return [...new Set(jobsById.values())]
        .filter(job => admin || job.user === user)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(job => job.toJSON());
}

export function hasRunningJobs() {
    return activeByKey.size > 0;
}

export function abortAllJobs() {
    for (const job of activeByKey.values()) {
        job.controller.abort();
    }
}

function pruneFinished() {
    const now = Date.now();
    for (const [id, job] of jobsById) {
        if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) {
            jobsById.delete(id);
        }
    }
}

export function resetJobs() {
    abortAllJobs();
    jobsById.clear();
    activeByKey.clear();
}
