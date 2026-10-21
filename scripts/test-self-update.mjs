import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { default as simpleGit, CheckRepoActions } from 'simple-git';

// Same sandbox as test-extension-manager.mjs: config.yaml keys come from env vars, git runs against an empty global config.
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baibaoku-self-update-')));
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

const { buildSelfUpdateRoutes, runSelfUpdate } = await import('../self-update.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const readConfig = (cwd, key) => {
    try {
        return git(cwd, 'config', '--get', key);
    } catch {
        return null;
    }
};
const options = (root, extra = {}) => ({ root, autoUpdate: true, dataRoot: null, ...extra });

// Accepts connections and never answers, like GitHub without a VPN.
const sockets = new Set();
const blackHole = net.createServer(socket => {
    sockets.add(socket);
    // Killed git processes reset their connections
    socket.on('error', () => {});
});
await new Promise(resolve => blackHole.listen(0, '127.0.0.1', resolve));
const blackHoleUrl = `http://127.0.0.1:${blackHole.address().port}/baibaoku.git`;
after(() => {
    sockets.forEach(socket => socket.destroy());
    blackHole.close();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        // Windows may still hold a killed git process's files
    }
});

let caseCount = 0;
// A bare "GitHub" repo and its clone as plugins/baibaoku, both at 1.0.0 on main.
function createPlugin() {
    const base = path.join(tmpRoot, `case-${++caseCount}`);
    const remote = path.join(base, 'remote.git');
    const author = path.join(base, 'author');
    const plugin = path.join(base, 'baibaoku');
    fs.mkdirSync(author, { recursive: true });
    git(base, 'init', '--bare', '-b', 'main', remote);
    git(author, 'init', '-b', 'main');
    git(author, 'remote', 'add', 'origin', remote);
    const publish = version => {
        fs.writeFileSync(path.join(author, 'package.json'), `${JSON.stringify({ version })}\n`);
        git(author, 'add', '-A');
        git(author, 'commit', '-m', version);
        git(author, 'push', 'origin', 'main');
        return git(author, 'rev-parse', 'HEAD');
    };
    publish('1.0.0');
    git(base, 'clone', remote, plugin);
    return { plugin, publish };
}

// The calls plugin-loader.js makes for every plugin before loading any of them.
async function stStartupUpdate(dir) {
    const repo = simpleGit(dir);
    assert.ok(await repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT));
    await repo.fetch();
    const commitHash = await repo.revparse(['HEAD']);
    const trackingBranch = await repo.revparse(['--abbrev-ref', '@{u}']);
    const log = await repo.log({ from: commitHash, to: trackingBranch });
    if (log.total > 0) {
        await repo.pull();
    }
    return trackingBranch;
}

test('hands SillyTavern a local upstream so its startup update never touches the network', { timeout: 30_000 }, async () => {
    const { plugin, publish } = createPlugin();
    assert.equal((await runSelfUpdate(options(plugin))).status, 'up-to-date');
    assert.equal(readConfig(plugin, 'branch.main.remote'), '.');
    assert.equal(readConfig(plugin, 'branch.main.merge'), 'refs/remotes/origin/main');
    assert.equal(readConfig(plugin, 'branch.main.pushRemote'), 'origin');

    // Downloaded by an earlier run, then the remote turns into a black hole.
    const latest = publish('1.1.0');
    git(plugin, 'fetch', 'origin');
    git(plugin, 'remote', 'set-url', 'origin', blackHoleUrl);
    assert.equal(await stStartupUpdate(plugin), 'origin/main');
    assert.equal(git(plugin, 'rev-parse', 'HEAD'), latest);
    assert.match(git(plugin, 'status', '-sb'), /^## main\.\.\.origin\/main/);
});

test('updates itself before the main code loads', async () => {
    const { plugin, publish } = createPlugin();
    await runSelfUpdate(options(plugin));
    const latest = publish('1.1.0');
    assert.equal((await runSelfUpdate(options(plugin))).status, 'updated');
    assert.equal(git(plugin, 'rev-parse', 'HEAD'), latest);
    assert.equal(git(plugin, 'rev-parse', 'origin/main'), latest);
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')).version, '1.1.0');
});

test('a slow download keeps going in the background and lands on the next start', async () => {
    const { plugin, publish } = createPlugin();
    await runSelfUpdate(options(plugin));
    const current = git(plugin, 'rev-parse', 'HEAD');
    const latest = publish('1.1.0');
    const result = await runSelfUpdate(options(plugin, { downloadWaitMs: 0 }));
    assert.equal(result.status, 'downloading');
    assert.equal((await result.pending).code, 0);
    assert.equal(git(plugin, 'rev-parse', 'HEAD'), current);
    assert.equal(git(plugin, 'rev-parse', 'origin/main'), latest);
    await stStartupUpdate(plugin);
    assert.equal(git(plugin, 'rev-parse', 'HEAD'), latest);
});

test('gives up after the probe timeout when the remote never answers', async () => {
    const { plugin } = createPlugin();
    git(plugin, 'remote', 'set-url', 'origin', blackHoleUrl);
    const started = Date.now();
    assert.equal((await runSelfUpdate(options(plugin, { probeTimeoutMs: 1000 }))).status, 'unreachable');
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('leaves local edits alone', async () => {
    const { plugin, publish } = createPlugin();
    await runSelfUpdate(options(plugin));
    fs.writeFileSync(path.join(plugin, 'package.json'), 'edited\n');
    publish('1.1.0');
    assert.equal((await runSelfUpdate(options(plugin))).status, 'dirty');
    assert.equal(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'), 'edited\n');
});

test('turning it off restores the original upstream', async () => {
    const { plugin } = createPlugin();
    await runSelfUpdate(options(plugin));
    git(plugin, 'config', 'baibaoku.selfUpdate', 'false');
    assert.equal((await runSelfUpdate(options(plugin))).status, 'disabled');
    assert.equal(readConfig(plugin, 'branch.main.remote'), 'origin');
    assert.equal(readConfig(plugin, 'branch.main.merge'), 'refs/heads/main');
    assert.equal(readConfig(plugin, 'branch.main.pushRemote'), null);
    assert.equal(readConfig(plugin, 'baibaoku.upstream.branch'), null);

    // enableServerPluginsAutoUpdate: false never takes over in the first place.
    const other = createPlugin();
    assert.equal((await runSelfUpdate(options(other.plugin, { autoUpdate: false }))).status, 'disabled');
    assert.equal(readConfig(other.plugin, 'branch.main.remote'), 'origin');
    assert.equal((await runSelfUpdate(options(path.join(tmpRoot, 'missing')))).status, 'not-repo');
});

test('route list starts with the routes the extension manager saw working', () => {
    const now = Date.now();
    const routes = buildSelfUpdateRoutes('https://gh-proxy.org/https://github.com/baibai-git/baibaoku.git', {
        routeStats: {
            'github.com': {
                direct: { okAt: now - 60_000, failAt: now, latencyMs: 100 },
                'proxy:http://127.0.0.1:7890': { okAt: now, failAt: 0, latencyMs: 800 },
                'mirror:https://ghfast.top/': { okAt: now, failAt: 0, latencyMs: 300 },
            },
        },
    });
    assert.deepEqual(routes.map(route => route.id), ['mirror:https://ghfast.top/', 'proxy:http://127.0.0.1:7890', 'mirror:https://gh-proxy.org/', 'direct']);
    assert.equal(routes[0].url, 'https://ghfast.top/https://github.com/baibai-git/baibaoku.git');
    assert.equal(routes[1].proxy, 'http://127.0.0.1:7890');
    assert.equal(routes[3].url, 'https://github.com/baibai-git/baibaoku.git');
    assert.equal(buildSelfUpdateRoutes('https://github.com/baibai-git/baibaoku.git', { configuredProxy: true })[0].id, 'system');
    assert.deepEqual(buildSelfUpdateRoutes('git@github.com:baibai-git/baibaoku.git').map(route => route.kind), ['system']);
});
