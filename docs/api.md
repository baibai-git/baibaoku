# API

所有接口挂载在：

```text
/api/plugins/baibaoku
```

POST 请求需要 SillyTavern 的 CSRF 请求头。前端扩展中推荐使用：

```js
import { getRequestHeaders } from '/script.js';
```

响应统一格式：

```json
{
  "ok": true,
  "data": {}
}
```

错误格式：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_DATABASE",
    "message": "Database name must match /^[a-z0-9][a-z0-9._-]{0,79}$/."
  }
}
```

## 命名规则

`database`：

```text
正则：^[a-z0-9][a-z0-9._-]{0,79}$
示例：com.author.my-extension、character-notes、xyzw.cache
```

`store`：

```text
默认值：default
正则：^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$
示例：settings、cache、characters
```

`key`：

```text
非空字符串，最大 1024 字符，不能包含空字符。
可以使用斜杠做逻辑前缀，例如 char_123/profile。
```

`value`：

```text
默认类型为 json，支持任意 JSON 可序列化值。
可通过 type 或 valueType 指定 json、text、blob、float32。
blob / float32 的 HTTP 传输值是 base64 字符串，SQLite 内部按 BLOB 保存。
float32 也接受 number[]，服务端会写入 little-endian Float32 BLOB。
单个值默认最大 5MB；blob / float32 按解码后的二进制大小计算。
```

## GET /health

检查插件是否加载、SQLite 驱动是否可用。

```text
GET /api/plugins/baibaoku/health
```

## GET /v1/status

给其他扩展探测柏宝库是否安装、版本号和 SQLite 驱动状态。

```text
GET /api/plugins/baibaoku/v1/status
```

正常响应：

```json
{
  "ok": true,
  "data": {
    "installed": true,
    "id": "baibaoku",
    "name": "柏宝库",
    "version": "0.7.1",
    "capabilities": {
      "saveGenerateCompleteResponseTool": true,
      "regexBridge": true
    },
    "apiVersion": "v1",
    "storage": "per-user",
    "user": "default-user",
    "driver": {
      "available": true,
      "package": "better-sqlite3"
    }
  }
}
```

`capabilities` 声明当前版本支持的可选能力。`saveGenerateCompleteResponseTool` 为 `true` 时，save-generate 可以解包单个完整回复工具（见下文），前端据此决定是否接管这类请求。`regexBridge` 为 `true` 时，柏宝库已把正则桥接写进 `public/scripts/extensions/regex/engine.js`（见 `GET /v1/status` 之后的重启要求）；注意该字段只说明版本支持，是否真的在当前页面生效要看 `getRegexedString` 的源码里有没有 `__baibaokuRegexBridge`，更新柏宝库后未重启酒馆或未刷新页面时两者可能不一致。

如果请求返回 404、403 或网络错误，调用方应该视为柏宝库不可用。柏宝库没安装时，它自己无法返回状态，所以“未安装”需要由调用方捕获请求失败来判断。

## GET /v1/client.js

返回前端 companion 脚本。加载后会注册 `window.BaiBaoKu`，并派发 `baibaoku:ready` 事件。

```js
await import('/api/plugins/baibaoku/v1/client.js');

if (window.BaiBaoKu && await window.BaiBaoKu.isAvailable()) {
  const db = window.BaiBaoKu.database('vector-cache');
  await db.open({ displayName: '向量缓存', version: 1 });
}
```

## POST /v1/open

打开数据库；不存在就创建。

```json
{
  "database": "character-notes",
  "displayName": "角色笔记",
  "version": 1
}
```

响应：

```json
{
  "ok": true,
  "data": {
    "database": "character-notes",
    "displayName": "角色笔记",
    "version": 1,
    "path": "baibaoku/databases/character-notes.sqlite",
    "stats": {
      "keys": 0,
      "sizeBytes": 20480
    }
  }
}
```

## POST /v1/set

写入一个值。

```json
{
  "database": "character-notes",
  "store": "settings",
  "key": "theme",
  "type": "json",
  "value": {
    "mode": "dark"
  }
}
```

带过期时间：

```json
{
  "database": "character-notes",
  "store": "cache",
  "key": "last-result",
  "value": [1, 2, 3],
  "ttl": 3600
}
```

`ttl` 单位是秒。

写入二进制：

```json
{
  "database": "vector-cache",
  "store": "vectors",
  "key": "chat_001/0001",
  "type": "float32",
  "value": "AACAPwAAAEAAAEBA"
}
```

## POST /v1/set-many

批量写入。同一个请求内的条目会在 SQLite transaction 中写入；任意一条失败时整批回滚。

```json
{
  "database": "vector-cache",
  "store": "vectors",
  "type": "float32",
  "entries": [
    {
      "key": "chat_001/0001",
      "value": "AACAPwAAAEAAAEBA"
    },
    {
      "key": "chat_001/0002",
      "value": "AACgPwAAIEAAAEhA"
    }
  ]
}
```

每个 entry 也可以单独指定 `type`、`valueType` 或 `ttl`。

## POST /v1/get

读取一个值。

```json
{
  "database": "character-notes",
  "store": "settings",
  "key": "theme"
}
```

存在：

```json
{
  "ok": true,
  "data": {
    "exists": true,
    "type": "json",
    "bytes": 15,
    "value": {
      "mode": "dark"
    }
  }
}
```

不存在：

```json
{
  "ok": true,
  "data": {
    "exists": false,
    "value": null
  }
}
```

## POST /v1/get-many

按 key 列表批量读取值。适合向量索引、批量缓存恢复等场景。

```json
{
  "database": "vector-cache",
  "store": "vectors",
  "keys": [
    "item_001",
    "item_002",
    "item_003"
  ]
}
```

响应会按请求中的 `keys` 顺序返回：

```json
{
  "ok": true,
  "data": {
    "database": "vector-cache",
    "store": "vectors",
    "entries": [
      {
        "key": "item_001",
        "exists": true,
        "type": "json",
        "bytes": 15,
        "value": [0.1, 0.2, 0.3]
      },
      {
        "key": "item_002",
        "exists": false,
        "value": null
      }
    ]
  }
}
```

单次最多 1000 个 key。

## POST /v1/has

检查 key 是否存在。

```json
{
  "database": "character-notes",
  "store": "settings",
  "key": "theme"
}
```

## POST /v1/delete

删除一个 key。

```json
{
  "database": "character-notes",
  "store": "settings",
  "key": "theme"
}
```

## POST /v1/delete-many

批量删除 key。

```json
{
  "database": "vector-cache",
  "store": "vectors",
  "keys": [
    "chat_001/0001",
    "chat_001/0002"
  ]
}
```

## POST /v1/keys

列出 key。

```json
{
  "database": "character-notes",
  "store": "characters",
  "prefix": "char_123/",
  "limit": 100,
  "offset": 0
}
```

## POST /v1/entries

列出 key 和 value。

```json
{
  "database": "character-notes",
  "store": "characters",
  "prefix": "char_123/",
  "limit": 100,
  "offset": 0
}
```

## POST /v1/clear

清空一个 store，或清空某个前缀。

```json
{
  "database": "character-notes",
  "store": "cache"
}
```

```json
{
  "database": "character-notes",
  "store": "characters",
  "prefix": "char_123/"
}
```

## POST /v1/info

查看数据库信息。

```json
{
  "database": "character-notes"
}
```

## POST /v1/chats/save-generate

Experimental SillyTavern chat-completions wrapper. It keeps the original
`/api/backends/chat-completions/generate` body under `generate`, and adds a
separate `save` descriptor so the server can persist the generated assistant
message after generation finishes.

Supported in v1:
- single-character chats only
- normal and regenerate assistant replies only
- chat-completions only
- no multi-swipe (`n > 1`)
- at most one complete-response envelope tool (`emit_complete_response` or `emit_complete_response_<alphanumeric suffix>` with a required string `content` parameter); its arguments are unwrapped into a normal assistant reply, and all other tool calls are rejected

Request:
```json
{
  "save": {
    "kind": "character",
    "type": "normal",
    "chatId": "Character - 2026-06-10",
    "avatar_url": "character.png",
    "file_name": "Character - 2026-06-10",
    "ch_name": "Character",
    "expectedVersion": "12345:1781000000000.123"
  },
  "generate": {
    "type": "normal",
    "messages": [],
    "model": "gpt-4.1",
    "stream": false,
    "chat_completion_source": "openai"
  }
}
```

For non-streaming requests, the endpoint waits for generation and the save
attempt to finish, then returns the original chat-completions response body.
The job id is exposed in `X-Baibaoku-Save-Generate-Job-Id`, and the terminal
save status is exposed in `X-Baibaoku-Save-Generate-Status`.

For streaming requests, the endpoint streams the provider SSE back to the
client and exposes the job id in `X-Baibaoku-Save-Generate-Job-Id`. If the
stream already produced assistant text, later stream truncation or upstream
errors are treated as a partial but valid generation and the collected text is
saved. Explicit API errors with no assistant text are reported as generation
failures. When a complete-response envelope tool is used, its arguments are
withheld from the client and not persisted until the call is fully received and
validated; incomplete or invalid arguments fail the generation instead of being
saved as a partial reply.

Poll status:
```text
POST /api/plugins/baibaoku/v1/chats/save-generate/status
POST /api/plugins/baibaoku/v1/chats/save-generate/cancel
POST /api/plugins/baibaoku/v1/chats/save-generate/:jobId/cancel
GET  /api/plugins/baibaoku/v1/chats/save-generate/pending?chatId=...&lastMessageHash=...
GET  /api/plugins/baibaoku/v1/chats/save-generate/:jobId
```

`pending?chatId=...` returns the latest save-generate job for the current user
and chat id. This lets the frontend recover the job id after a page refresh or
mobile browser resume while generation is still running.
If `lastMessageHash` is provided and it matches the saved job message floor and
content, the endpoint returns `data: null` because the frontend already has the
result. The hash should be calculated from the last visible message floor number
and `mes` content.

Terminal statuses:
```text
completed
saved
already_saved
conflict
failed
canceled
```

`completed` means the generation result was persisted by BaiBaoKu in the per-user
SQLite database but was not written to the chat file. The frontend should let
SillyTavern perform its normal chat save when the page is still online, or
recover the persisted result after a reconnect.

Cancel accepts either `jobId` or `chatId` in the request body. If cancellation
happens during generation, already streamed partial text is discarded and is not
persisted as a successful result.
