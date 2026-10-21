import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

// getConfigValue exits the process when config.yaml is missing, so feed the keys it reads through env vars.
// Git runs against an empty global config so the developer's proxy/signing/autocrlf settings can't leak in.
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baibaoku-ext-')));
const gitConfigFile = path.join(tmpRoot, 'gitconfig');
fs.writeFileSync(gitConfigFile, '');
Object.assign(process.env, {
    SILLYTAVERN_GIT_BACKEND: 'system',
    SILLYTAVERN_REQUESTPROXY_ENABLED: 'false',
    SILLYTAVERN_REQUESTPROXY_URL: '',
    GIT_CONFIG_GLOBAL: gitConfigFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
});
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete process.env[key];
}
globalThis.DATA_ROOT = path.join(tmpRoot, 'data');
const managerRoot = path.join(globalThis.DATA_ROOT, '_baibaoku', 'extension-manager');
fs.mkdirSync(managerRoot, { recursive: true });
fs.writeFileSync(path.join(managerRoot, 'config.json'), JSON.stringify({ autoDetectProxy: false, probeTimeoutMs: 5000 }));
const userExtensions = path.join(globalThis.DATA_ROOT, 'tester', 'extensions');
fs.mkdirSync(userExtensions, { recursive: true });

const service = await import('../src/extension-manager/service.js');
const { getCloudMirrors, parseMirrorList, setCloudMirrorListUrl } = await import('../src/extension-manager/cloud-mirrors.js');
const { saveConfig } = await import('../src/extension-manager/config.js');
const { ExtensionOpError, classifyGitFailure } = await import('../src/extension-manager/errors.js');
const { removeExtensionDir } = await import('../src/extension-manager/fs-utils.js');
const { getJob, listJobs, resetJobs, runJob } = await import('../src/extension-manager/jobs.js');
const { flushOps } = await import('../src/extension-manager/oplog.js');
const { normalizeProxyUrl, parseRemoteUrl } = await import('../src/extension-manager/remote-url.js');
const { classifyFolder, cleanupLockFiles, hasLocalCommitsInReflog } = await import('../src/extension-manager/repo-fs.js');
const { isSafeBranchName, parseConflictFiles } = await import('../src/extension-manager/repo-system.js');
const { buildRoutes, decideRemote, orderFetchRoutes, parseLsRemote, saveRouteStats, summarizeRefs } = await import('../src/extension-manager/sources.js');
const { formatPlainError, interceptExtensionRoutes } = await import('../src/extension-manager/st-intercept.js');
// Keep the suite offline: never read the real cloud mirror list.
setCloudMirrorListUrl('');

// Global extensions resolve against the working directory; keep them inside the sandbox too.
const originalCwd = process.cwd();
process.chdir(tmpRoot);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const manifest = version => `${JSON.stringify({ display_name: 'Demo', version, author: 'tester', js: 'index.js' }, null, 4)}\n`;
const req = ({ admin = false } = {}) => ({
    user: { profile: { handle: 'tester', admin }, directories: { extensions: userExtensions } },
    get: () => undefined,
});
const rejectsWith = (promise, code, check = () => true) => assert.rejects(promise, error => {
    assert.ok(error instanceof ExtensionOpError, `expected ExtensionOpError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return check(error) !== false;
});

// Smart HTTP through `git http-backend`, so installs/updates take the same http code paths as GitHub.
const remotesRoot = path.join(tmpRoot, 'remotes');
fs.mkdirSync(remotesRoot);
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const env = {
        ...process.env,
        GIT_PROJECT_ROOT: remotesRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
    };
    if (request.headers['content-length']) env.CONTENT_LENGTH = request.headers['content-length'];
    if (request.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = request.headers['content-encoding'];
    if (request.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = request.headers['git-protocol'];
    const child = spawn('git', ['http-backend'], { env, windowsHide: true });
    child.stdin.on('error', () => {});
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let streaming = false;
    child.stdout.on('data', chunk => {
        if (streaming) {
            response.write(chunk);
            return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        let status = 200;
        for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
            const index = line.indexOf(':');
            const name = line.slice(0, index).trim();
            const value = line.slice(index + 1).trim();
            if (name.toLowerCase() === 'status') status = parseInt(value, 10);
            else response.setHeader(name, value);
        }
        response.writeHead(status);
        streaming = true;
        if (end + 4 < head.length) response.write(head.subarray(end + 4));
    });
    child.stdout.on('end', () => response.end());
    child.on('error', () => response.destroy());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;

function createRemote(name, files) {
    const work = path.join(tmpRoot, 'work', name);
    const bare = path.join(remotesRoot, `${name}.git`);
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    const commit = (message, changes) => {
        for (const [file, content] of Object.entries(changes)) {
            fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
            fs.writeFileSync(path.join(work, file), content);
        }
        git(work, 'add', '-A');
        git(work, 'commit', '-q', '-m', message);
        if (fs.existsSync(bare)) git(work, 'push', '-q', 'origin', 'main');
        return git(work, 'rev-parse', 'HEAD');
    };
    const first = commit('initial', files);
    git(tmpRoot, 'clone', '-q', '--bare', work, bare);
    git(work, 'remote', 'add', 'origin', bare);
    return { url: `${serverUrl}/${name}.git`, first, commit };
}

test.after(async () => {
    resetJobs();
    await flushOps();
    saveRouteStats();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('recognizes mirror origins and maps them back to GitHub', () => {
    const prefixed = parseRemoteUrl('https://ghfast.top/https://github.com/owner/repo.git');
    assert.deepEqual(prefixed.github, { owner: 'owner', repo: 'repo', hasGitSuffix: true });
    assert.deepEqual(prefixed.mirror, { kind: 'prefix', base: 'https://ghfast.top/' });
    assert.equal(prefixed.canonical, 'https://github.com/owner/repo.git');

    // Some reverse proxies collapse "https://" into "https:/".
    assert.equal(parseRemoteUrl('https://gh-proxy.com/https:/github.com/owner/repo').canonical, 'https://github.com/owner/repo');
    const domain = parseRemoteUrl('https://kkgithub.com/owner/repo', { domainMirrors: ['kkgithub.com'] });
    assert.deepEqual(domain.mirror, { kind: 'domain', host: 'kkgithub.com' });
    assert.equal(domain.canonical, 'https://github.com/owner/repo');

    const withToken = parseRemoteUrl('https://user:secret@github.com/owner/repo.git');
    assert.equal(withToken.hasCredentials, true);
    assert.equal(withToken.display.includes('secret'), false);
    assert.equal(parseRemoteUrl('git@github.com:owner/repo.git').isHttp, false);
    assert.equal(parseRemoteUrl('https://github.com/owner/repo/tree/main').github, null);
});

test('builds routes: canonical GitHub first, then proxies and mirrors, never mirrors for credentials', () => {
    const config = { prefixMirrors: ['https://ghfast.top/'], domainMirrors: ['kkgithub.com'] };
    const proxies = [{ url: 'http://127.0.0.1:7890' }];
    const routes = buildRoutes(parseRemoteUrl('https://old.example/https://github.com/owner/repo.git'), { config, proxies });
    assert.deepEqual(routes.map(route => [route.kind, route.url, route.authoritative]), [
        ['direct', 'https://github.com/owner/repo.git', true],
        ['proxy', 'https://github.com/owner/repo.git', true],
        ['mirror', 'https://ghfast.top/https://github.com/owner/repo.git', false],
        ['mirror', 'https://kkgithub.com/owner/repo.git', false],
        ['mirror', 'https://old.example/https://github.com/owner/repo.git', false],
    ]);
    assert.equal(routes[1].proxy, 'http://127.0.0.1:7890');

    const private_ = buildRoutes(parseRemoteUrl('https://user:secret@github.com/owner/repo.git'), { config, proxies });
    assert.deepEqual(private_.map(route => route.kind), ['direct', 'proxy']);
    const ssh = buildRoutes(parseRemoteUrl('git@github.com:owner/repo.git'), { config, proxies });
    assert.deepEqual(ssh.map(route => [route.id, route.sshLike]), [['origin', true]]);
});

test('parses the cloud mirror list: prefix and domain lines, comments, BOM, junk and duplicates', () => {
    const bom = String.fromCharCode(0xfeff);
    const list = parseMirrorList([
        `${bom}https://gh-proxy.org   # prefix mirror`,
        '# whole-line comment',
        '',
        'https://ghfast.top',
        'https://gh-proxy.org/',
        'KKGitHub.com/',
        'github.com',
        'not a mirror',
        'ftp://example.com/',
        'https://user:secret@evil.example/',
    ].join('\r\n'));
    assert.deepEqual(list, { prefixMirrors: ['https://gh-proxy.org/', 'https://ghfast.top/'], domainMirrors: ['kkgithub.com'] });
    const many = parseMirrorList(Array.from({ length: 25 }, (_, index) => `m${index}.example.com`).join('\n'));
    assert.equal(many.domainMirrors.length, 20);
});

test('reads the cloud mirror list once, caches it, and reports failures instead of throwing', async () => {
    let hits = 0;
    let status = 200;
    const listServer = http.createServer((request, response) => {
        hits += 1;
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('https://cloud.example/\nkkgithub.com\n');
    });
    await new Promise(resolve => listServer.listen(0, '127.0.0.1', resolve));
    try {
        assert.equal(await getCloudMirrors(), null);

        setCloudMirrorListUrl(`http://127.0.0.1:${listServer.address().port}/mirrors.txt`);
        const [first, second] = await Promise.all([getCloudMirrors(), getCloudMirrors()]);
        assert.equal(first, second);
        assert.deepEqual([first.ok, first.prefixMirrors, first.domainMirrors], [true, ['https://cloud.example/'], ['kkgithub.com']]);
        assert.equal(await getCloudMirrors(), first);
        assert.equal(hits, 1);

        status = 404;
        const failed = await getCloudMirrors({ force: true });
        assert.equal(hits, 2);
        assert.deepEqual([failed.ok, failed.error, failed.prefixMirrors], [false, 'HTTP 404', []]);
        assert.equal(await getCloudMirrors(), failed);
        assert.equal(hits, 2);
    } finally {
        setCloudMirrorListUrl('');
        listServer.closeAllConnections();
        await new Promise(resolve => listServer.close(resolve));
    }
});

test('normalizes proxy addresses', () => {
    assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
    assert.equal(normalizeProxyUrl('socks://127.0.0.1:1080'), 'socks5h://127.0.0.1:1080');
    assert.equal(normalizeProxyUrl(''), '');
    assert.equal(normalizeProxyUrl('ftp://127.0.0.1:21'), null);
    assert.equal(normalizeProxyUrl('http://127.0.0.1:7890/path'), null);
});

test('parses ls-remote output', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const parsed = parseLsRemote(`ref: refs/heads/main\tHEAD\n${a}\tHEAD\n${a}\trefs/heads/main\n${b}\trefs/heads/dev\n`);
    assert.deepEqual(summarizeRefs(parsed, 'dev'), { defaultBranch: 'main', defaultSha: a, branch: 'dev', branchSha: b });
    assert.deepEqual(summarizeRefs(parsed, 'gone'), { defaultBranch: 'main', defaultSha: a, branch: 'gone', branchSha: null });
});

test('decides the remote version: GitHub beats mirrors, mirrors vote, ties avoid downgrades', () => {
    const result = (id, sha, { authoritative = false, latencyMs = 100, priority = 0, defaultBranch = 'main' } = {}) => ({
        route: { id, label: id, kind: authoritative ? 'direct' : 'mirror', authoritative, priority },
        ok: true,
        latencyMs,
        refs: { defaultBranch, defaultSha: sha, branch: 'main', branchSha: sha },
    });
    const [old, fresh] = ['1'.repeat(40), '2'.repeat(40)];

    const withGithub = decideRemote([result('m1', old, { latencyMs: 10, defaultBranch: 'master' }), result('m2', old), result('direct', fresh, { authoritative: true, latencyMs: 500 })], { branch: 'main' });
    assert.equal(withGithub.sha, fresh);
    assert.equal(withGithub.authoritative, true);
    assert.equal(withGithub.defaultBranch, 'main', 'default branch comes from GitHub, not the faster stale mirror');
    assert.deepEqual(withGithub.disagreeing.map(item => item.route.id), ['m1', 'm2']);

    assert.equal(decideRemote([result('m1', old), result('m2', fresh), result('m3', fresh)], { branch: 'main' }).sha, fresh);
    // A tie between mirrors keeps what we already have rather than jumping to an unconfirmed version.
    assert.equal(decideRemote([result('m1', fresh, { priority: 0 }), result('m2', old, { priority: 1 })], { branch: 'main', localHead: old }).sha, old);
    assert.equal(decideRemote([result('m1', null), result('m2', old, { priority: 1 })], { branch: 'main' }).sha, old);
    assert.equal(decideRemote([{ ...result('m1', old), ok: false }]), null);
});

test('orders fetch routes: agreeing routes first, failed and disagreeing ones dropped', () => {
    const route = id => ({ id, label: id });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(route);
    const results = [{ route: a, ok: true }, { route: b, ok: false }, { route: c, ok: true }];
    assert.deepEqual(orderFetchRoutes({ routes: [a, b, c, d], results, decision: { agreeing: [results[0]] } }).map(item => item.id), ['a', 'd']);
});

test('classifies git failures', () => {
    assert.equal(classifyGitFailure('fatal: unable to access \'https://github.com/a/b/\': Could not resolve host: github.com').kind, 'dns');
    assert.equal(classifyGitFailure('fatal: unable to access \'https://github.com/a/b/\': Received HTTP code 407 from proxy after CONNECT').kind, 'proxy');
    assert.equal(classifyGitFailure('fatal: unable to access \'https://github.com/a/b/\': Failed to connect to github.com port 443 after 21 ms: Couldn\'t connect to server').kind, 'connect');
    assert.equal(classifyGitFailure('remote: Repository not found.\nfatal: repository \'https://github.com/a/b/\' not found').kind, 'not-found');
    assert.equal(classifyGitFailure('fatal: could not read Username for \'https://github.com\': terminal prompts disabled').kind, 'auth');
    assert.equal(classifyGitFailure('', { timedOut: true }).kind, 'timeout');
});

test('parses conflicting files and validates branch names', () => {
    const checkout = 'error: Your local changes to the following files would be overwritten by checkout:\n\tindex.js\n\tsrc/a b.js\nPlease commit your changes or stash them before you switch branches.\nAborting\n';
    assert.deepEqual(parseConflictFiles(checkout), ['index.js', 'src/a b.js']);
    assert.deepEqual(parseConflictFiles('error: Entry \'style.css\' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision \'abc\'.'), ['style.css']);

    for (const name of ['main', 'feature/x', 'v1.2', 'release-2024']) assert.equal(isSafeBranchName(name), true, name);
    for (const name of ['', '-x', 'a..b', 'a b', 'x.lock', '/a', 'a/', 'a~1', 'a:b', 'a@{1}', 'a\\b']) assert.equal(isSafeBranchName(name), false, name);
});

test('formats errors as one line for SillyTavern toasts', () => {
    assert.equal(formatPlainError(new ExtensionOpError('X', '仓库不存在', { hint: '检查地址。' })), '仓库不存在。检查地址。');
    assert.equal(formatPlainError(new ExtensionOpError('X', '下载失败。', { hint: '稍后重试。' })), '下载失败。稍后重试。');
    assert.equal(formatPlainError(new Error('line one\n  line two')), 'line one line two');
});

test('treats folders without manifest.json as residue, but follows linked dev extensions', async () => {
    const sandbox = path.join(tmpRoot, 'classify');
    const source = path.join(sandbox, 'source-ext');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'manifest.json'), manifest('1.0.0'));
    fs.mkdirSync(path.join(sandbox, 'half-installed', '.git'), { recursive: true });

    assert.equal((await classifyFolder(source)).residual, false);
    const half = await classifyFolder(path.join(sandbox, 'half-installed'));
    assert.equal(half.residual, true);
    assert.equal(half.hasGit, true);
    assert.equal((await classifyFolder(path.join(sandbox, 'missing'))).exists, false);

    const link = path.join(sandbox, 'linked-ext');
    fs.symlinkSync(source, link, 'junction');
    assert.equal((await classifyFolder(link)).residual, false);
    // Removing a linked extension must only drop the link, never the developer's source tree.
    assert.deepEqual(await removeExtensionDir(link), { leftover: false });
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(path.join(source, 'manifest.json')), true);
});

test('cleans stale git locks and recognizes local commits in the reflog', async () => {
    const gitDir = path.join(tmpRoot, 'locks', '.git');
    fs.mkdirSync(path.join(gitDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
    fs.writeFileSync(path.join(gitDir, 'HEAD.lock'), '');
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(gitDir, 'index.lock'), old, old);
    assert.deepEqual(await cleanupLockFiles(gitDir, 'main'), { removed: ['index.lock'], fresh: ['HEAD.lock'] });
    assert.deepEqual(await cleanupLockFiles(gitDir, 'main', { includeFresh: true }), { removed: ['HEAD.lock'], fresh: [] });

    const sha = '0'.repeat(40);
    const line = message => `${sha} ${sha} Tester <t@example.com> 1700000000 +0800\t${message}`;
    fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), `${line('clone: from https://github.com/a/b')}\n${line('pull origin main: Fast-forward')}\n`);
    assert.equal(await hasLocalCommitsInReflog(gitDir), false);
    fs.appendFileSync(path.join(gitDir, 'logs', 'HEAD'), `${line('commit: my tweak')}\n`);
    assert.equal(await hasLocalCommitsInReflog(gitDir), true);
});

test('joins identical requests, rejects conflicting ones, and replays by client job id', async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const spec = { key: 'jobs-test', signature: 'update|false', kind: 'update', user: 'tester', extension: 'x', timeoutMs: 60_000 };
    const first = runJob(spec, async () => {
        await gate;
        return { response: 'done' };
    });
    const joined = runJob(spec, () => assert.fail('a joined request must not run again'));
    assert.equal(joined.joined, true);
    assert.equal(joined.job, first.job);
    const retried = runJob({ ...spec, clientId: 'retry-job-0001' }, () => assert.fail('a retried request must not run again'));
    assert.equal(retried.job, first.job);
    assert.equal(getJob('retry-job-0001'), first.job);
    assert.equal(listJobs({ user: 'tester', admin: false }).filter(job => job.id === first.job.id).length, 1);
    const batch = service.getJobsForRequest(req(), `retry-job-0001,${first.job.id},missing-job-01`);
    assert.equal(batch['retry-job-0001'].id, first.job.id);
    assert.equal(batch[first.job.id].state, 'running');
    assert.equal(batch['missing-job-01'], null);
    const stranger = { user: { profile: { handle: 'stranger', admin: false } } };
    assert.equal(service.getJobsForRequest(stranger, first.job.id)[first.job.id], null);
    assert.throws(() => runJob({ ...spec, signature: 'delete' }, () => {}), error => error.code === 'BUSY' && error.status === 409);
    release();
    assert.deepEqual(await first.promise, { response: 'done' });

    const replaySpec = { ...spec, key: 'jobs-replay', clientId: 'client-job-0001' };
    const replay = runJob(replaySpec, async () => ({ response: 'once' }));
    assert.equal(replay.job.id, 'client-job-0001');
    await replay.promise;
    const again = runJob(replaySpec, () => assert.fail('a replayed request must not run again'));
    assert.equal(again.joined, true);
    assert.deepEqual(await again.promise, { response: 'once' });
});

test('wraps and restores the native extension routes', async () => {
    const native = async (_request, response) => response.send('native');
    const layer = routePath => ({ route: { path: routePath, methods: { post: true }, stack: [{ handle: native }] } });
    const router = { stack: [layer('/install'), layer('/update'), layer('/delete'), layer('/version'), layer('/discover')] };
    const fakeResponse = () => ({
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        writableFinished: false,
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        type(value) {
            this.headers['Content-Type'] = value;
            return this;
        },
        send(body) {
            this.body = body;
            this.headersSent = true;
            return this;
        },
        end() {
            this.headersSent = true;
        },
        once() {},
        off() {},
    });

    const restore = interceptExtensionRoutes(router);
    const install = router.stack[0].route.stack[0];
    assert.notEqual(install.handle, native);
    assert.equal(router.stack[4].route.stack[0].handle, native, 'routes we do not take over stay untouched');

    const rejected = fakeResponse();
    await install.handle({ ...req(), body: { url: 'ftp://example.com/repo.git' } }, rejected, () => {});
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.headers['X-Baibaoku-Error-Code'], 'INVALID_URL');
    assert.equal(rejected.headers['X-Baibaoku-Extension-Op'], 'error');
    assert.match(rejected.body, /http/);

    saveConfig({ interceptEnabled: false });
    try {
        const passthrough = fakeResponse();
        await install.handle({ ...req(), body: {} }, passthrough, () => {});
        assert.equal(passthrough.body, 'native');
    } finally {
        saveConfig({ interceptEnabled: true });
    }

    // Reloading the plugin wraps the original handler again instead of stacking wrappers.
    const restoreAgain = interceptExtensionRoutes(router);
    restoreAgain();
    assert.equal(install.handle, native);
    restore();
    assert.equal(install.handle, native);
});

test('installs over smart HTTP, refuses duplicates and clears half-installed residue', async () => {
    const remote = createRemote('demo-ext', { 'manifest.json': manifest('1.0.0'), 'index.js': 'one\n', 'style.css': 'a {}\n' });
    const outcome = await service.installExtension(req(), { url: remote.url }, { source: 'test' });
    const dir = path.join(userExtensions, 'demo-ext');
    assert.equal(outcome.response.folderName, 'demo-ext');
    assert.equal(outcome.response.version, '1.0.0');
    assert.equal(outcome.response.extensionPath, dir);
    assert.equal(outcome.response.baibaoku.commit, remote.first);
    assert.equal(git(dir, 'config', '--get', 'remote.origin.url'), remote.url);
    assert.equal(fs.existsSync(path.join(userExtensions, '.baibaoku-staging')), false);
    await rejectsWith(service.installExtension(req(), { url: remote.url }), 'ALREADY_EXISTS', error => error.status === 409);

    const other = createRemote('residue-ext', { 'manifest.json': manifest('2.0.0') });
    const residue = path.join(userExtensions, 'residue-ext');
    fs.mkdirSync(path.join(residue, '.git'), { recursive: true });
    fs.writeFileSync(path.join(residue, 'partial.js'), 'half\n');
    const reinstalled = await service.installExtension(req(), { url: other.url });
    assert.equal(reinstalled.response.version, '2.0.0');
    assert.match(reinstalled.response.baibaoku.warnings.join('\n'), /残留/);
    assert.equal(fs.existsSync(path.join(residue, 'partial.js')), false);
    assert.equal(fs.existsSync(path.join(residue, 'manifest.json')), true);
    const trashed = fs.readdirSync(path.join(managerRoot, 'trash'));
    assert.ok(trashed.some(entry => fs.existsSync(path.join(managerRoot, 'trash', entry, 'residue-ext', 'partial.js'))));

    await rejectsWith(service.installExtension(req(), { url: remote.url, global: true }), 'FORBIDDEN', error => error.status === 403);
});

test('updates: version check, fast-forward keeping unrelated edits, then up to date', async () => {
    const dir = path.join(userExtensions, 'demo-ext');
    const work = path.join(tmpRoot, 'work', 'demo-ext');
    const commit = (message, changes) => {
        for (const [file, content] of Object.entries(changes)) fs.writeFileSync(path.join(work, file), content);
        git(work, 'commit', '-qam', message);
        git(work, 'push', '-q', 'origin', 'main');
        return git(work, 'rev-parse', 'HEAD');
    };
    const second = commit('v1.1', { 'index.js': 'two\n', 'manifest.json': manifest('1.1.0') });

    const version = await service.checkExtensionVersion(req(), { extensionName: '/demo-ext' }, { includeRemoteManifest: true });
    assert.equal(version.isUpToDate, false);
    assert.equal(version.currentBranchName, 'main');
    assert.equal(version.baibaoku.remoteCommit, second);

    fs.writeFileSync(path.join(dir, 'style.css'), 'a { color: red; }\n');
    const updated = await service.updateExtension(req(), { extensionName: '/demo-ext' });
    assert.equal(updated.response.isUpToDate, false);
    assert.equal(updated.response.shortCommitHash, second.slice(0, 7));
    assert.deepEqual([...updated.response.baibaoku.files].sort(), ['index.js', 'manifest.json']);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), second);
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'two\n');
    assert.equal(fs.readFileSync(path.join(dir, 'style.css'), 'utf8'), 'a { color: red; }\n', 'edits the update does not touch are kept');

    const again = await service.updateExtension(req(), { extensionName: 'demo-ext' });
    assert.equal(again.response.isUpToDate, true);
    assert.equal((await service.checkExtensionVersion(req(), { extensionName: 'demo-ext' })).isUpToDate, true);
});

test('updates: conflicting edits and local commits are refused, force backs up and aligns', async () => {
    const dir = path.join(userExtensions, 'demo-ext');
    const work = path.join(tmpRoot, 'work', 'demo-ext');
    const commit = (message, changes) => {
        for (const [file, content] of Object.entries(changes)) fs.writeFileSync(path.join(work, file), content);
        git(work, 'commit', '-qam', message);
        git(work, 'push', '-q', 'origin', 'main');
        return git(work, 'rev-parse', 'HEAD');
    };
    const before = git(dir, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(dir, 'index.js'), 'my edit\n');
    const third = commit('v1.2', { 'index.js': 'three\n' });
    await rejectsWith(service.updateExtension(req(), { extensionName: 'demo-ext' }), 'LOCAL_CHANGES', error => {
        assert.equal(error.status, 409);
        assert.deepEqual(error.details.files, ['index.js']);
    });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'my edit\n', 'a refused update writes nothing');

    const forced = await service.updateExtension(req(), { extensionName: 'demo-ext', force: true });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), third);
    assert.equal(forced.response.baibaoku.forced, true);
    assert.equal(fs.readFileSync(path.join(forced.response.baibaoku.backupPath, 'index.js'), 'utf8'), 'my edit\n');
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'three\n');

    fs.writeFileSync(path.join(dir, 'style.css'), 'local commit\n');
    git(dir, 'commit', '-qam', 'my own tweak');
    const fourth = commit('v1.3', { 'index.js': 'four\n' });
    await rejectsWith(service.updateExtension(req(), { extensionName: 'demo-ext' }), 'DIVERGED', error => error.status === 409);
    const aligned = await service.updateExtension(req(), { extensionName: 'demo-ext', force: true });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), fourth);
    assert.ok(aligned.response.baibaoku.backupPath);
});

test('version check on a folder that is not a git repo answers like the native endpoint', async () => {
    const plain = path.join(userExtensions, 'plain-ext');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'manifest.json'), manifest('0.1.0'));
    assert.deepEqual(await service.checkExtensionVersion(req(), { extensionName: 'plain-ext' }), {
        currentBranchName: '',
        currentCommitHash: '',
        isUpToDate: true,
        remoteUrl: '',
    });
    await rejectsWith(service.updateExtension(req(), { extensionName: 'plain-ext' }), 'NOT_A_REPO');
    await rejectsWith(service.updateExtension(req(), { extensionName: 'no-such-ext' }), 'NOT_FOUND', error => error.status === 404);
});

test('lists and cleans residue only on an explicit request', async () => {
    const broken = path.join(userExtensions, 'broken-ext');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'leftover.txt'), '');
    fs.mkdirSync(path.join(userExtensions, '.baibaoku-staging'), { recursive: true });

    assert.deepEqual((await service.listResiduals(req())).map(item => item.name), ['broken-ext']);
    assert.deepEqual(await service.cleanResiduals(req(), {}), { results: [] });
    assert.equal(fs.existsSync(broken), true);
    const cleaned = await service.cleanResiduals(req(), { items: [{ name: 'broken-ext', global: false }] });
    assert.equal(cleaned.results.length, 1);
    assert.equal(cleaned.results[0].ok, true);
    assert.equal(fs.existsSync(broken), false);
    fs.rmdirSync(path.join(userExtensions, '.baibaoku-staging'));
});

test('deletes into the trash and answers like the native endpoint', async () => {
    const dir = path.join(userExtensions, 'demo-ext');
    const outcome = await service.deleteExtension(req(), { extensionName: 'demo-ext' });
    assert.equal(outcome.text, `Extension has been deleted at ${dir}`);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(path.join(outcome.response.trashPath, 'manifest.json')), true);
    const op = service.getOpForRequest(req(), outcome.opId);
    assert.equal(op.kind, 'delete');
    assert.equal(op.ok, true);
});

test('builtin git backend installs and updates over smart HTTP too', async () => {
    process.env.SILLYTAVERN_GIT_BACKEND = 'builtin';
    try {
        const remote = createRemote('builtin-ext', { 'manifest.json': manifest('1.0.0'), 'index.js': 'one\n', 'style.css': 'a {}\n' });
        const installed = await service.installExtension(req(), { url: remote.url });
        const dir = path.join(userExtensions, 'builtin-ext');
        assert.equal(installed.response.baibaoku.commit, remote.first);

        const second = remote.commit('v1.1', { 'index.js': 'two\n' });
        assert.equal((await service.checkExtensionVersion(req(), { extensionName: 'builtin-ext' })).isUpToDate, false);
        fs.writeFileSync(path.join(dir, 'style.css'), 'a { color: red; }\n');
        const updated = await service.updateExtension(req(), { extensionName: 'builtin-ext' });
        assert.equal(updated.response.isUpToDate, false);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), second);
        assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'two\n');
        assert.equal(fs.readFileSync(path.join(dir, 'style.css'), 'utf8'), 'a { color: red; }\n');

        fs.writeFileSync(path.join(dir, 'index.js'), 'my edit\n');
        remote.commit('v1.2', { 'index.js': 'three\n' });
        await rejectsWith(service.updateExtension(req(), { extensionName: 'builtin-ext' }), 'LOCAL_CHANGES');
        assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), 'my edit\n');
        assert.equal(git(dir, 'rev-parse', 'HEAD'), second);
    } finally {
        process.env.SILLYTAVERN_GIT_BACKEND = 'system';
    }
});
