import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { getConfigValue } from '../../../../src/util.js';
import { classifyGitFailure } from './errors.js';
import { lastMeaningfulLine } from './util.js';

const PROXY_ENV_KEYS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];
const MAX_STDOUT_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const NETWORK_CONCURRENCY = 12;

const activeChildren = new Set();
const networkQueue = [];
let networkActive = 0;
let systemGitPromise = null;

export class GitCommandError extends Error {
    constructor(args, result) {
        super(`git ${args[0]} 失败:${lastMeaningfulLine(result.stderr) || `退出码 ${result.code}`}`);
        this.name = 'GitCommandError';
        this.result = result;
        this.failure = classifyGitFailure(result.stderr, result);
    }
}

export function detectSystemGit() {
    systemGitPromise ??= new Promise(resolve => {
        execFile('git', ['--version'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
            resolve(error ? null : String(stdout).trim().replace(/^git version\s*/i, '') || 'unknown');
        });
    });
    return systemGitPromise;
}

// 跟随酒馆 config.yaml 的 git.backend;配置成 system 但机器上没有 git 时退回内置实现,而不是直接报错。
export async function resolveGitBackend() {
    let preferred = 'auto';
    try {
        preferred = String(getConfigValue('git.backend', 'auto') ?? 'auto').trim().toLowerCase();
    } catch {
        preferred = 'auto';
    }
    const systemGitVersion = await detectSystemGit();
    const backend = preferred === 'builtin' || !systemGitVersion ? 'builtin' : 'system';
    return { backend, preferred, systemGitVersion };
}

/**
 * 运行一条 git 命令,永远 resolve(不 throw),由调用方根据 code 判断。
 * network: 传入线路 { kind, proxy } 时视为联网命令:显式指定代理(直连时清空)、禁止交互式登录、限制低速连接。
 * repoDir: 在扩展仓库里执行时传入,禁止 git 往上层目录找仓库(全局扩展的上层就是酒馆自己的仓库)。
 */
export async function runGit(args, options = {}) {
    const {
        cwd,
        repoDir = null,
        timeoutMs = 120000,
        network = null,
        gitProxyKeys = [],
        signal,
        onProgress,
    } = options;

    const configArgs = ['-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'advice.detachedHead=false'];
    if (process.platform === 'win32') {
        // 有的扩展目录层级很深,超过 Windows 260 字符限制时 clone/reset 会失败
        configArgs.push('-c', 'core.longpaths=true');
    }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;

    if (repoDir) {
        configArgs.push('-c', 'safe.directory=*');
        env.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(repoDir));
    }

    if (network) {
        const proxy = network.proxy || '';
        // ext:: 能执行任意命令,远端地址来自扩展自己的配置,明确禁掉(git 默认也是禁的,防止全局配置打开过)
        configArgs.push('-c', `http.proxy=${proxy}`, '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', '-c', 'core.askPass=', '-c', 'protocol.ext.allow=never');
        for (const key of gitProxyKeys) {
            if (key !== 'http.proxy') {
                configArgs.push('-c', `${key}=${proxy}`);
            }
        }
        if (network.kind === 'mirror') {
            configArgs.push('-c', 'credential.helper=');
        }
        for (const key of PROXY_ENV_KEYS) {
            delete env[key];
        }
        env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes -o ConnectTimeout=15';
    }

    let release = null;
    if (network) {
        release = await acquireNetworkSlot(signal);
        if (!release) {
            return { code: -1, stdout: '', stderr: 'aborted', timedOut: false, aborted: true, durationMs: 0 };
        }
    }

    try {
        return await spawnGit([...configArgs, ...args], { cwd: cwd ?? repoDir ?? undefined, env, timeoutMs, signal, onProgress });
    } finally {
        release?.();
    }
}

export async function gitOk(args, options) {
    const result = await runGit(args, options);
    if (result.code !== 0) {
        throw new GitCommandError(args, result);
    }
    return result.stdout;
}

function spawnGit(args, { cwd, env, timeoutMs, signal, onProgress }) {
    return new Promise(resolve => {
        const started = Date.now();
        let child;
        try {
            child = spawn('git', args, {
                cwd,
                env,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false, aborted: false, durationMs: 0 });
            return;
        }

        activeChildren.add(child);
        let stdout = '';
        let stderr = '';
        let progressBuffer = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            if (stdout.length < MAX_STDOUT_CHARS) {
                stdout += chunk;
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => {
            stderr += chunk;
            if (stderr.length > MAX_STDERR_CHARS) {
                stderr = stderr.slice(-MAX_STDERR_CHARS);
            }
            if (onProgress) {
                progressBuffer += chunk;
                const lines = progressBuffer.split(/\r|\n/);
                progressBuffer = lines.pop() ?? '';
                lines.forEach(line => emitProgress(line, onProgress));
            }
        });

        const timer = timeoutMs > 0 ? setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs) : null;
        const onAbort = () => {
            aborted = true;
            killTree(child);
        };
        if (signal?.aborted) {
            onAbort();
        } else {
            signal?.addEventListener('abort', onAbort, { once: true });
        }

        const finish = code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            activeChildren.delete(child);
            resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
        };
        child.on('error', error => {
            stderr += `\n${error?.message ?? error}`;
            finish(-1);
        });
        child.on('close', code => finish(code ?? -1));
    });
}

function emitProgress(line, onProgress) {
    const match = /^(?:remote:\s*)?([A-Za-z ]+):\s+(\d{1,3})%(?:.*\|\s*([\d.]+\s*[KMG]?i?B\/s))?/.exec(line.trim());
    if (!match) return;
    try {
        onProgress({ phase: match[1].trim(), percent: Number(match[2]), speed: match[3] ?? '' });
    } catch {
        // 进度回调出错不影响 git 本身
    }
}

function killTree(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {
            // 进程已经退出
        }
    }
}

export function killAllGitProcesses() {
    for (const child of activeChildren) {
        killTree(child);
    }
    activeChildren.clear();
}

function acquireNetworkSlot(signal) {
    if (signal?.aborted) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const grant = () => {
            signal?.removeEventListener('abort', onAbort);
            networkActive++;
            let released = false;
            resolve(() => {
                if (released) return;
                released = true;
                networkActive--;
                networkQueue.shift()?.();
            });
        };
        const onAbort = () => {
            const index = networkQueue.indexOf(grant);
            if (index !== -1) networkQueue.splice(index, 1);
            resolve(null);
        };
        if (networkActive < NETWORK_CONCURRENCY) {
            grant();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        networkQueue.push(grant);
    });
}
