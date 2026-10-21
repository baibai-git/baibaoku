# 柏宝库 BaiBaoKu

柏宝库是一个 SillyTavern server plugin，为纯前端扩展提供统一的本地 KV 数据库能力。

它对开发者暴露简单的 `open / set / set-many / get / get-many / delete / delete-many / keys / entries` 接口，底层使用 SQLite 保存数据。数据库文件会保存到当前 SillyTavern 用户的数据目录中，所以用户备份自己的 `data/<user>/` 文件夹时，柏宝库数据会一起被备份。

## 特性

- 每个数据库一个独立 SQLite 文件。
- `open(database)` 有则打开，没有则创建。
- 支持 `store + key + value` 的 KV 模型，value 类型包括 `json`、`text`、`blob` 和 `float32`。
- 支持 `ttl` 过期时间，适合缓存。
- 自动兼容 SillyTavern 单用户和多用户模式。
- 不开放 SQL，不允许前端指定文件路径。
- 没有 UI，只提供功能接口和开发者文档。

## 安装

详见 [docs/install.md](docs/install.md)。

简短版本：

```bash
cd SillyTavern/plugins
git clone <your-repo-url> baibaoku
cd baibaoku
npm install --omit=dev
```

然后在 SillyTavern `config.yaml` 中启用：

```yaml
enableServerPlugins: true
```

重启 SillyTavern 后访问：

```text
GET /api/plugins/baibaoku/v1/status
```

其他扩展也可以用这个接口探测柏宝库是否安装、当前版本号和 SQLite 驱动状态。

### 自动更新

酒馆启动时，柏宝库会在加载主代码之前检查并更新自己：在直连、代理和镜像之间挑能用的线路，最多等几秒，连不上就先用当前版本启动。为了不让酒馆自带的插件自动更新直连 GitHub 卡住启动，柏宝库会把当前分支的上游改成本地的 `origin/<分支>`，所以在柏宝库目录里直接 `git pull` 只会合并已经下载好的提交，要联网拉取请用 `git pull origin main`。

自己开发柏宝库的目录可以运行 `git config baibaoku.selfUpdate false` 关掉（同时恢复原来的上游）；酒馆 `config.yaml` 里设了 `enableServerPluginsAutoUpdate: false` 时也不会自动更新。

前端扩展也可以加载 companion 脚本：

```js
await import('/api/plugins/baibaoku/v1/client.js');
```

脚本会注册 `window.BaiBaoKu` 并派发 `baibaoku:ready` 事件。其他扩展可以先判断前端 bridge 是否存在，再调用 `window.BaiBaoKu.isAvailable()` 做后端和 SQLite 驱动细查。

## 数据位置

单用户模式：

```text
data/default-user/baibaoku/databases/<database>.sqlite
```

多用户模式：

```text
data/<user-handle>/baibaoku/databases/<database>.sqlite
```

柏宝库不会硬编码 `default-user`，而是使用 SillyTavern 当前请求中的 `req.user.directories.root`。

SQLite 使用 WAL 模式时会出现 `<database>.sqlite-wal` 和 `<database>.sqlite-shm`。柏宝库会在后端设置 WAL 保留上限，并在累计写入较多数据后自动执行 checkpoint/truncate；前端扩展不需要自己维护这些文件。

## 后台生成的完整回复工具兼容

`0.6.4` 起，save-generate 支持 OpenAI / Custom 来源中单个 `emit_complete_response` 或 `emit_complete_response_<字母数字后缀>` 工具，要求参数 schema 包含必填的字符串 `content`。原请求和工具定义保持不变；后端只把返回的完整正文工具解析为普通 assistant content，不执行任意工具。

流式工具参数会在收齐并校验后输出正文；非流式也会统一浏览器响应和后台保存内容。多工具、错误函数名、截断或无效参数会报错，不会作为成功回复保存。普通文本回复（含代理错误正文）保持兼容。

更新后需要重启 SillyTavern，并搭配支持该能力的前端扩展。`/v1/status` 返回 `data.capabilities.saveGenerateCompleteResponseTool: true`，供前端判断是否可接管这类请求。

离线回归测试：`npm run test:save-generate`（不请求上游 API、不读写用户聊天）。黑名单检测和自动重新生成仍由前端负责，关闭页面后不会在服务端运行。

## 正则引擎桥接

`0.7.0` 起，柏宝库会在启动时把一段桥接代码注入酒馆的 `public/scripts/extensions/regex/engine.js`，让前端扩展能在每条显示正则执行前插一脚。注入块用 `// baibaoku regex bridge:start` / `end` 标记包裹，每次启动先清掉旧块再按锚点重插，可重复执行；`engine.js` 结构不匹配已知锚点时不会写入，并在控制台给出警告。

桥接协议：`getRegexedString()` 运行每条正则前会先调用

```js
globalThis.__baibaokuRegexBridge?.beforeScript?.(script, finalString, context)
```

返回字符串时，这个字符串就被当作该条正则的执行结果（返回传入的 `finalString` 即等于跳过这条正则）；返回其它类型或抛错时，照常执行原正则。`context` 包含 `version`、`placement`、`isMarkdown`、`isPrompt`、`depth` 和 `characterOverride`。桥接本身不做任何判断，跳过哪些正则、什么时候跳过都由装监听的前端扩展决定（例如柏宝箱的「流式生成时跳过美化正则」只在流式生成中的楼层显示渲染里跳过替换内容带代码块的正则）。

注入发生在插件 `init` 阶段，改的是磁盘上的 `engine.js`，所以更新柏宝库后必须重启 SillyTavern，并刷新页面才会生效；`/v1/status` 返回 `data.capabilities.regexBridge: true` 表示当前版本会做注入，不代表当前页面已经生效。离线回归测试：`npm run test:regex-bridge`（只测注入逻辑，不会改动真实的 `engine.js`）。

## 开发者文档

- [API 文档](docs/api.md)
- [前端调用示例](docs/sdk.md)
- [使用场景示例](docs/examples.md)

## 安全边界

柏宝库用于本地扩展数据和缓存，不是密钥管理器。不要用它保存 API key、密码、令牌或真实身份信息。

前端扩展运行在同一个页面环境中，柏宝库无法对不同前端扩展做真正的强隔离。数据库名用于组织数据，不应被当作安全权限边界。
