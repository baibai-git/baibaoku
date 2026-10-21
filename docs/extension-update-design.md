# 扩展更新服务设计（baibaoku + 柏宝箱前端）

> 状态：设计稿，未实现。
> 目标：让插件更新**有真实错误信息**、**不会假成功**、**能自动选镜像/代理**。
> 主要落点在 `plugins/baibaoku`；前端改动在 `public/scripts/extensions/third-party/SillyTavern-Mobile-Resize-Guard`。

---

## 1. 要解决的问题

| # | 现象 | 根因（已核对代码） |
|---|------|-------------------|
| 1 | 更新失败只显示 `Internal Server Error. Check the server logs for more details.` | `src/endpoints/extensions.js:212` 把真实异常吞掉，只返回固定文案；前端 `public/scripts/extensions.js:1370-1373` 只把响应体塞进 toastr |
| 2 | 提示更新成功/已是最新，但文件没变 | 见下方 2.1 ~ 2.6 |
| 3 | 不能自动选镜像/代理 | `/update` 只用仓库 `origin`；`config.yaml` 的 `requestProxy` 不影响 git 子进程；没有镜像重写和失败降级 |

### 2.1 分支参照物不一致

酒馆 `/update` 只 pull **当前本地分支**：

```js
const currentBranch = await git.branch();
await git.pull('origin', currentBranch.current);
```

而前端静默检查读的是 `raw.githubusercontent.com/.../main/manifest.json`。

当前仓库实际状态（分析时）：

- 当前分支 `chore/migrate-to-vue-draggable` 与远端一致 → 酒馆报 `isUpToDate: true`
- `origin/main` 比 HEAD 多 56 个提交，但 **tree 完全相同**（都是 `0c51c63`），全是 merge commit
- 本地 `main` 落后 `origin/main` 298 个提交

因此“更新成功但文件没变”可能完全属实：commit 变了，内容没变。

### 2.2 `/update` 顺序有坑

`src/endpoints/extensions.js:193` 先 `checkIfRepoIsUpToDate`（内部 `git fetch` + `git log HEAD..origin/<branch>`），**之后**才检查是不是 git 仓库。本地分支在远端已删除时，`origin/<branch>` 不存在，`git log` 抛 `unknown revision` → 500。

### 2.3 成功状态用 pull 前的结果，commit 用 pull 后的 HEAD

`isUpToDate` 来自 pull 之前，`shortCommitHash` 来自 pull 之后。`git pull` 可能 no-op 或只产生 merge commit，导致“成功但没变化”。

### 2.4 浅克隆

酒馆安装扩展用 `--depth 1`，浅仓库里 `git log HEAD..origin/branch` 在部分 fetch 深度组合下不可靠。

### 2.5 没有系统 git

`/update`、`/version` 硬编码 `simple-git`，忽略 `git.backend: builtin`。服务器没装 git 时是 `spawn git ENOENT` → 500。

### 2.6 前端缓存

manifest 里是 `dist/index.js?ver=1.1.0`。版本号不 bump，URL 不变，可能继续用旧脚本。

### 2.7 其他

- Windows 上 `dist/index.js` 被占用/杀软扫描 → pull 失败
- 本地未提交改动 → pull 拒绝
- pull 失败可能留下 `MERGE_HEAD`，后续更新更乱
- 酒馆自动更新前端只等 60 秒（`autoUpdateExtensions` 的 `AbortSignal.timeout`），浏览器断开后服务端 git 仍在跑，可能产生并发的第二次更新

---

## 2. 方案总览

**服务端拦截为主，前端只做 UX 和兜底。**

```
浏览器（酒馆原生面板 / 柏宝箱面板）
  │  POST /api/extensions/update            （原生）
  │  POST /api/plugins/baibaoku/v1/extensions/update （柏宝箱）
  ▼
baibaoku
  ├─ st-intercept.js  包装 extensionsRouter 的 /update /version /branches
  ├─ routes.js        JSON API + 完整诊断
  ├─ service.js       检查 → 选源 → fetch → 落地 → 校验 → 回滚
  ├─ mirror-resolver.js 直连/镜像/代理探测、缓存、降级
  └─ git-runner.js    system git / isomorphic-git 统一封装
```

选择服务端拦截的原因：

1. 覆盖酒馆启动时的 `autoUpdateExtensions`，不依赖前端脚本加载顺序
2. 手机/其他客户端行为一致
3. 真实 stderr 可记录、可结构化返回
4. 酒馆前端 bug 不用改 ST 源码

---

## 3. 后端模块

新增目录 `plugins/baibaoku/src/extension-updates/`：

```
extension-updates/
├── routes.js           # /v1/extensions/* JSON 接口
├── st-intercept.js     # 包装酒馆 extensionsRouter，保留原 handler 兜底
├── service.js          # 更新流程、并发锁、校验、回滚
├── repo.js             # 路径解析、仓库检查、分支解析、manifest 读取
├── git-runner.js       # system git / isomorphic-git
├── mirror-resolver.js  # 探测、缓存、候选源
├── config.js           # 服务端配置（JSON 文件）
└── log.js              # 最近 N 次记录 + 文件日志
```

在 `index.js` 的 `init(router)` 里注册（建议加配置开关，默认开启拦截）。

### 3.1 JSON API

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/extensions/update` | 执行更新 |
| POST | `/v1/extensions/update-preview` | 只 fetch + 比较，不改工作区 |
| POST | `/v1/extensions/version` | 分支、HEAD、upstream、远端分支、是否落后、目标版本 |
| POST | `/v1/extensions/branches` | 本地/远端分支 |
| POST | `/v1/extensions/switch` | 切换分支（可选） |
| GET/POST | `/v1/extensions/update-config` | 镜像模式、候选列表、超时、脏工作区策略 |
| GET | `/v1/extensions/update-log` | 最近更新记录（手机查看完整错误） |

请求：

```json
{
  "extensionName": "SillyTavern-Mobile-Resize-Guard",
  "global": false,
  "branch": null,
  "mode": "auto"
}
```

成功响应：

```json
{
  "ok": true,
  "extensionName": "...",
  "before": { "branch": "main", "commit": "abc1234", "version": "1.1.0", "dirty": false },
  "after":  { "branch": "main", "commit": "def5678", "version": "1.1.1" },
  "target": { "ref": "refs/heads/main", "commit": "def5678" },
  "updated": true,
  "filesChanged": 12,
  "contentChanged": true,
  "strategy": "fast-forward",
  "source": { "kind": "mirror", "url": "https://ghfast.top/https://github.com/...", "latencyMs": 840 },
  "attempts": [
    { "kind": "direct", "ok": false, "error": "timeout" },
    { "kind": "mirror", "ok": true }
  ],
  "branchFallback": false,
  "elapsedMs": 4210
}
```

失败响应：HTTP 4xx/5xx，**不要 200 假成功**。

```json
{
  "ok": false,
  "error": {
    "code": "FETCH_FAILED",
    "stage": "fetch",
    "message": "所有更新源都不可用",
    "details": {
      "attempts": [],
      "stderrTail": "...",
      "dirtyFiles": ["dist/index.js"],
      "suggestions": ["..."]
    }
  }
}
```

`stage` 固定枚举：`resolve-path` / `validate` / `inspect-repo` / `resolve-branch` / `probe` / `fetch` / `apply` / `verify` / `reload`。

### 3.2 酒馆兼容层

```js
import { router as extensionsRouter } from '../../../src/endpoints/extensions.js';
```

包装 `extensionsRouter.stack` 中 `path === '/update'` 的 route handler：

- 保留原 handler，作为 fallback
- 只接管 `/update`、`/version`、`/branches`（`/switch` 可选）
- 失败返回**纯文本**（酒馆原生前端会直接 toastr 响应体），例如：

  ```
  更新失败 [fetch]
  原因: 直连和 4 个镜像都超时(最后错误: connection timed out)
  建议: 在柏宝箱设置里指定代理,或更换镜像源
  ```

- 成功返回酒馆期望字段：`shortCommitHash`、`extensionPath`、`isUpToDate`、`remoteUrl`，再附加扩展字段
- `exit()` 时恢复原 handler
- 注意 `extensionsEnabledFeatureGuard`：包装 route handler 不会绕过它；若改用 `stack.unshift` 需自行检查 `extensions.enabled`

---

## 4. 更新算法

**不要用 `git pull`。** 改为 fetch 到临时 ref 再显式落地。

### Step 0 路径与权限

- 与酒馆一致：`global ? PUBLIC_DIRECTORIES.globalExtensions : req.user.directories.extensions`
- `sanitize-filename` + `realpath` 双重校验，防止路径逃逸
- `global` 必须 `req.user.profile.admin`

### Step 1 检查仓库

读取：是否 git 仓库、当前分支、HEAD、upstream、remote URL、是否 shallow、`git status --porcelain`、是否处于 merge/rebase 中。

非 git 仓库返回独立错误码，提示重装或使用压缩包模式。

### Step 2 决定目标分支

优先级（可配置）：

1. 请求显式传入的 `branch`
2. 该扩展保存的偏好分支
3. 当前本地分支的 upstream 同名远端分支（存在时）
4. 远端默认 HEAD
5. `main`

当前本地分支在远端不存在时，不要比较 `origin/<本地分支>`，直接回退到 3/4/5，并在结果标记 `branchFallback: true`。

### Step 3 选源

见第 5 节。

### Step 4 fetch 到临时 ref，不改 origin

```bash
git fetch <chosenUrl> +refs/heads/<branch>:refs/baibaoku/update/<branch>
```

- 目标 commit = `refs/baibaoku/update/<branch>`
- 浅仓库按需 `--depth=1` 或先 `--unshallow`
- 镜像 URL 只用于本次 fetch，不写进 remote 配置

### Step 5 比较

- `target === HEAD` 且 tree 相同 → `updated: false, reason: "up-to-date"`
- target 是 HEAD 后代 → 可快进
- 双方分叉 → 默认报错，除非显式 `mode: "reset"`

### Step 6 落地

| 场景 | 行为 |
|---|---|
| 干净 + 可快进 | `git merge --ff-only <target>` |
| 脏工作区 | 默认拒绝，返回脏文件列表；可选 `dirtyPolicy: "stash"`（`git stash push -u` → 更新 → `stash pop`） |
| 分叉 / 强制对齐 | 仅 `mode: "reset"` 时 `git reset --hard <target>`，先做轻量备份 |

### Step 7 校验（解决假成功）

- `git rev-parse HEAD === target`
- 读取更新后的 `manifest.json`，返回新 `version`
- `git diff --name-status before..after` 统计真实变更文件数
- commit 变了但文件没变 → `updated: true, contentChanged: false`，前端文案应为“已同步到远端提交，文件内容没有变化”
- 校验失败且原本工作区干净 → `git reset --hard before` 回滚并报错

### Step 8 并发 / 超时 / 日志

- 每个扩展目录一个异步锁，第二次请求返回 409“更新进行中”
- 默认 120 秒超时，超时杀进程树（Windows: `taskkill /T /F`）
- 记录最近 N 次结果，`update-log` 可查

### 非 git / 无系统 git

- 有 `.git` 但没 git 二进制：用 `isomorphic-git`，或 tarball 模式
- 完全没 `.git`：tarball 覆盖（需处理远端已删除文件），默认关闭，作为显式选项

---

## 5. 镜像 / 代理

### 候选源

1. **direct**：原始 remote
2. **proxy**：临时给 git 加参数，不改全局配置
   ```
   git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=... fetch ...
   ```
   同时读取 `HTTPS_PROXY` / `ALL_PROXY` 环境变量
3. **mirror（URL 前缀）**，仅 github.com：
   ```
   https://ghproxy.net/https://github.com/<owner>/<repo>.git
   https://ghfast.top/https://github.com/<owner>/<repo>.git
   https://gh-proxy.com/https://github.com/<owner>/<repo>.git
   https://github.moeyy.xyz/https://github.com/<owner>/<repo>.git
   https://hub.gitmirror.com/https://github.com/<owner>/<repo>.git
   ```
4. **mirror（域名替换）**：`kkgithub.com`、`bgithub.xyz`
5. **raw 镜像**（只用于读 manifest，不用于 git）：jsDelivr、`raw.gitmirror.com`
6. **tarball 兜底**：`codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>`

> 镜像可用性变化快，默认列表放配置文件，允许随时增删。

### 默认顺序（auto）

1. 环境变量代理
2. 仓库已有 `git config http.proxy`
3. 自动探测本地代理端口：7890、7897、1080、10809、8888、8080
4. direct
5. 镜像列表（并发探测，按延迟排序）
6. tarball

### 探测与缓存

- `git ls-remote --heads <url> <branch>`，超时 6~8 秒
- 并发探测，记录 `{url, kind, latencyMs, okAt}`
- 每个 remote 缓存 10~30 分钟；失败源短 TTL（约 2 分钟）
- fetch 失败立即失效该源，换下一个，结果返回 `attempts`
- `/version` 可先用缓存，`/update` 必须重新确认

### 安全

- 只对已知 GitHub 域名做镜像重写
- remote URL 含用户名/密码/token 时禁用镜像，避免泄漏
- SSH remote 默认不镜像
- 只允许 `http:` / `https:`
- 永远不改写 `origin`

---

## 6. 前端改动

### 6.1 `src/features/updateCheck.js`

- 不再直接抓 `raw.githubusercontent.com/.../main/manifest.json`
- 改为调用后端 `/v1/extensions/version`，拿目标分支的远端 commit 和 manifest version
- 更新成功后先调用 `/version` 校验 commit/版本真的变了，再提示成功并 reload

### 6.2 `src/features/updateDiagnostics.js`

- 保留 500 兜底
- 主路径改成后端诊断，渲染 `stage`、`attempts`、`dirtyFiles`、`gitBackend`、`hasSystemGit`、`stderrTail`、`isShallow`、`mergeState`、`branchFallback`
- 不再需要“浏览器探测 GitHub”这种间接证据
- 目前 hook 只处理 `status === 500`，可扩展到 403/404/超时

### 6.3 设置面板

- 更新通道/分支：跟随当前分支 / 固定 main / 手动选择
- 镜像模式：auto / direct / 指定镜像 / 指定代理
- 脏工作区策略：拒绝 / 自动 stash / 强制 reset
- 详细错误开关

### 6.4 缓存

- 建议更新后 bump manifest 版本，或把 commit 短哈希放进 `js` 查询串
- reload 前可清一次 `caches`（如果有 Service Worker）

---

## 7. 兼容与风险

- 包装 `extensionsRouter` 依赖酒馆内部结构（Express 4.22）。加功能开关；找不到 route 时自动降级并打日志
- 酒馆升级可能改接口：字段用可选读取，失败 fallback 原 handler
- 后端插件自更新需要重启 Node；`plugin-loader` 启动自动更新同样用 `git pull`，有相同的坑（本次可不做）
- 权限：全局扩展仅 admin；用户扩展按 `req.user`；建议加频率限制
- reset 模式前备份到 `data/<user>/baibaoku/backups/extensions/`
- 测试场景：
  - 干净仓库快进
  - 脏工作区拒绝 / stash 成功 / stash 冲突
  - 本地分支无远端对应
  - shallow 仓库
  - 无系统 git（isomorphic-git）
  - 直连失败 → 镜像成功
  - 所有源失败 → 结构化错误
  - commit 变了但文件没变（当前仓库场景）
  - 并发更新同一扩展

---

## 8. 实施顺序

1. **Phase 1**：`git-runner` + `service` + `routes`，先不拦截，手动调 API 验证
2. **Phase 2**：`st-intercept` 接管 `/update`、`/version`、`/branches`，验证原生面板可用
3. **Phase 3**：前端改用后端接口 + 设置面板 + 诊断弹窗
4. **Phase 4**：分支切换、更新全部、tarball 兜底、自更新提示

---

## 9. 待拍板（建议默认值）

| 项 | 建议默认 |
|---|---|
| 更新目标分支 | 当前分支的 upstream；不存在则远端默认 HEAD（`main`），并显示实际跟踪分支 |
| 脏工作区 | 默认拒绝，返回脏文件列表；设置里可选 stash |
| 拦截范围 | 所有第三方扩展 |
| 拦截方式 | 服务端包装 `extensionsRouter`，前端 fetch 改写作为兜底 |
| 镜像模式 | `auto`，候选列表可配置 |
| 非 git 安装 | 默认关闭，显式开启 tarball |
| 版本口径 | 同时展示 manifest version 和 commit；`contentChanged` 单独返回 |
| 后端自更新 | 本次不做，只提示需要重启 |
