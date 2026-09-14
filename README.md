# DeepSeek Harness Antigravity OAuth

将 Google Antigravity 账号中的 Gemini 模型接入
[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)，作为原生 LLM provider 使用。

- Provider ID：`antigravity`
- 运行方式：DSH Web profile 插件
- 认证方式：Google OAuth，本机保存 refresh token

> [!WARNING]
> 本插件调用 Antigravity 的非公开内部 API，不是 Google 官方 Gemini API 集成。使用它可能违反
> Google 服务条款，也可能导致账号受限或封禁。请自行评估风险，不要使用重要账号。Google 或
> Antigravity 的协议变更可能随时使插件失效。

## 免责声明

本项目及其作者与 Google、DeepSeek 或 Antigravity 官方没有隶属、授权或赞助关系。

本插件仅供学习和技术研究使用。用户须自行确认其所在地区的法律法规、Google 服务条款以及相关账号政策，并自行承担使用本插件产生的全部风险，包括但不限于账号限制、服务中断、数据丢失或其他损失。

本项目调用的接口属于非公开接口，作者不保证其长期可用性、稳定性或兼容性，也不承诺为因接口变化、账号策略变化或第三方服务故障导致的问题提供修复。

请勿将 OAuth callback URL、authorization code、access token、refresh token 或其他敏感信息提交到 issue、日志、截图或公开仓库。

## 功能

- Gemini 文本生成、thinking 和 tool calls/results
- 图像输入：图片附件以 Gemini `inlineData` 内联发送
- 流式响应、usage、abort、自动刷新 token 和失败重试
- Web UI 设置页直接唤起 Google 登录，并自动接收 OAuth callback
- Models 设置页删除/恢复 provider
- Antigravity 设置页退出登录并删除本机 OAuth 凭据

模型声明 `text` 和 `image` 输入模态，因此模型选择器和附件通道会把图片正常下发。当前不支持 PDF
输入和多账号轮换；图像生成模型不会注册到模型选择器。

PDF 之所以不可用，不是 Antigravity 的限制（上游支持 `application/pdf` 的 `inlineData`），而是
DSH 的附件通道只保存位图：`image/png`、`image/jpeg`、`image/webp`、`image/gif`，没有 PDF
内容块可以下发。

## 模型

登录后插件会调用上游的 `v1internal:fetchAvailableModels` 获取当前账号可用的模型，并与内置列表合并：

```text
antigravity-gemini-3.7-flash
antigravity-gemini-3.6-flash
antigravity-gemini-3.5-flash
antigravity-gemini-3.1-pro
antigravity-<上游新增模型>      例如 antigravity-gemini-3.8-flash
```

上游新增 Gemini 文本模型（`*-pro` / `*-flash`）时，模型选择器里会自动出现，**不需要更新插件**：

- 上游模型名去掉 `antigravity-` 前缀后就是请求使用的 model id；`-preview`、`-tiered`、`-low/-medium/-high`
  等后缀会归一化，tier 通过 reasoning effort 选择，因此不会出现重复条目。
- 只注册「插件实际会发送的 wire id 在上游目录里存在」的模型，所以显示名一定对应真正被调用的模型；
  上游目录里的别名不会造成错标（例如键 `gemini-2.5-flash` 的上游显示名是 "Gemini 3.5 Flash Lite"），
  解析器无法忠实转换的家族（`*-flash-lite`、无 tier 的 `gemini-3-flash`）也不会进入选择器。
- 显示名由模型 id 推导，因为上游 displayName 会随返回顺序变化（3.8 Flash 时而标 `(Low)` 时而标 `(Medium)`）。
- 结果缓存 15 分钟；查询失败时回退到内置列表，并在 60 秒内不再重试，避免模型选择器卡在网络上。
- 未登录或上游不可达时使用内置列表，所以选择器不会为空。
- 只注册 Gemini `*-pro` / `*-flash` 文本模型；图像生成、Claude、gpt-oss 等上游条目不在本插件范围内。

`*-pro` 支持 `low` 和 `high` reasoning effort；其他模型支持 `low`、`medium` 和 `high`。

## 兼容性

- Node.js 20 或更高版本
- `@deepseek-ai/dsh@0.1.0-rc.6` 开发/验证基线
- 安装验证：`dsh` CLI `0.1.5-rc.1`（`@deepseek-ai/dsh-*` `0.1.5-rc.2`）
- OAuth 和 transport 由 [cortexkit/antigravity-auth](https://github.com/cortexkit/antigravity-auth)
  提供

dsh 在测试阶段会有破坏性更新。插件已适配以下变更，并同时兼容新旧宿主：

| 变更 | 旧宿主 | 新宿主 | 插件做法 |
| --- | --- | --- | --- |
| tool call id 类型 | `CallId` | `ToolCallId` | 从 `ToolCallBlock['id']` 推导，不导入品牌函数 |
| settings 命名空间 | `settingsNamespace()` | 仅接受字面量 | 使用 `'llm-antigravity-oauth'` 字面量 |
| 前端 Context 类型 | `dsh-client-runtime/client` | `@deepseek-ai/cordis` | 从 cordis 导入 `Context` 类型 |

## 安装

### 使用预构建包

打开 [GitHub Releases](https://github.com/Eridani075/deepseek-harness-antigravity-oauth/releases/latest)，
在 Assets 中下载 `dsh-antigravity-oauth-*.tgz`，然后安装下载的文件：

```bash
dsh plugin --profile web add "/absolute/path/to/dsh-antigravity-oauth-VERSION.tgz"
dsh --profile web --dump-config
```

### 从源码构建

在项目目录执行：

```bash
npm ci
npm run check
npm run pack
```

产物位于 `artifacts/`。安装生成的 tarball：

```bash
dsh plugin --profile web add "/absolute/path/to/artifacts/dsh-antigravity-oauth-VERSION.tgz"
dsh --profile web --dump-config
```

`--dump-config` 输出中应出现 `dsh-antigravity-oauth` bundle 和
`llm-antigravity-oauth` 条目。安装或升级插件后，重启已经运行的 DSH Web 服务再刷新浏览器；
不要在已有服务占用 `127.0.0.1:3080` 时重复启动第二个 `dsh web`。

安装时 `pnpm` 可能提示缺少 DSH peer dependencies，以及 `hono`、`arctic`。DSH peer 由宿主提供，
`hono` 和 `arctic` 不在本插件使用的 OAuth/transport 路径中；只要 bundle 能正常加载，就不需要
为了消除提示而重复安装这些依赖到 profile。

## 登录

### Web UI

打开 DSH Web UI 的 Settings → Antigravity，点击「登录 Google」并完成授权。插件会在 DSH Host
侧监听本机 OAuth callback 并自动保存凭据，正常情况下不需要手动复制 code。浏览器阻止新标签页时，
页面会提供一次性的「打开授权页面」按钮。

### CLI

```bash
dsh plugin --profile web exec dsh-antigravity-login
```

CLI 会监听 `127.0.0.1:51121` 并打印 Google OAuth URL。授权完成后 callback 会自动交给 CLI；如果
自动 callback 失败，可以粘贴完整 callback URL 或 authorization code。

凭据默认保存到：

```text
${DSH_HOME:-~/.dsh}/antigravity-oauth.json
```

可以通过 `DSH_ANTIGRAVITY_AUTH_FILE` 指定其他路径。POSIX 系统上的凭据文件权限会设置为 `0600`。

## Provider 和凭据管理

登录后，在模型选择器中选择 `antigravity` provider 和上面的模型 ID。

### 删除或恢复 provider

Settings → Models 中的 Google Antigravity provider 使用 DSH 原生 Delete 操作：

- Delete 会移除 provider 配置并停用 adapter，但保留 OAuth 凭据文件。
- Settings → Antigravity 中的「启用提供商」可以恢复 provider，无需重新登录。

### 退出登录

Settings → Antigravity →「退出登录」会删除本机 OAuth 凭据文件，但不会撤销 Google 账号侧的应用
授权。重新使用模型前需要再次登录。

## 故障排查

### 模型没有出现在模型选择器

确认插件安装到当前使用的 profile，并检查：

```bash
dsh --profile web --dump-config
```

确认输出包含 `dsh-antigravity-oauth` 和 `llm-antigravity-oauth` 后，重启 DSH Web 服务并重新打开
Settings → Models。

### `EADDRINUSE: 127.0.0.1:3080`

已有 DSH Web 服务正在运行。刷新已有页面即可；需要加载新插件版本时，重启旧服务后再打开，
不要并行启动第二个 `dsh web`。

### `EADDRINUSE: 127.0.0.1:51121`

退出旧的 `dsh-antigravity-login`，确认 OAuth callback 端口释放后再重试。

### `Antigravity image input requires the host attachment service`

宿主没有提供 durable attachment service，插件无法读取图片字节。确认当前 DSH 版本包含 attachment
服务（Web profile 默认包含），并检查该图片是否仍在 attachment 存储中。若图片读取失败，错误信息会
带上底层原因，例如附件已被清理。

### 启动时报 `does not provide an export named ...`

dsh 测试阶段会重命名或移除导出，例如 `CallId` → `ToolCallId`、移除 `settingsNamespace`。先升级插件
到最新版本；仍报错时，在 issue 中附上 `dsh --version` 和完整报错。不要附带任何 OAuth 凭据。

### `Antigravity token exchange failed: fetch failed`

登录时插件先用授权码换取 token（`oauth2.googleapis.com`），随后**尽力**读取 userinfo 用于显示邮箱。
如果 `www.googleapis.com` 不可达（被网络屏蔽，或代理只放行了部分 Google 域名），旧版本会把整个
登录判定为失败。0.2.6 起 userinfo 失败不再影响登录，只是不显示邮箱。

浏览器能打开 Google 授权页不代表 DSH 宿主机进程也能访问这些域名，两者出口可能不同。宿主机必须能访问：

- `oauth2.googleapis.com`：换取和刷新 token，必需
- `cloudcode-pa.googleapis.com` 或 `daily-cloudcode-pa.sandbox.googleapis.com`：模型请求，必需

`www.googleapis.com` 只影响邮箱显示。验证连通性：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://oauth2.googleapis.com/token
curl -sS -o /dev/null -w "%{http_code}\n" https://cloudcode-pa.googleapis.com/
```

### `User location is not supported for the API use`

这是 Google 对**请求出口**的地区限制，判断依据是 DSH 宿主机进程的出口 IP，浏览器能打开授权页不代表
宿主机出口可用，两者可能走不同线路。

关键点是**限制按节点生效，而不是按国家生效**：实测同一台机器上，一个美国机房节点被拒（HTTP 400
`FAILED_PRECONDITION`），换成另一个节点（日本）后连续请求全部成功。所以遇到这个错误时：

1. 查看宿主机出口并多测几次，确认节点是否在轮换：
   ```bash
   curl -sS https://ipinfo.io/json
   ```
2. 找到一个能通过的节点后固定它（关闭自动测速/轮换），或者给 DSH 显式指定代理：
   ```bash
   HTTPS_PROXY=http://127.0.0.1:7890 \
   NO_PROXY=127.0.0.1,localhost \
   dsh web
   ```
3. 换节点后如果仍然报同样的错，说明该节点出口被拒绝，继续换；这个错误无法通过重试自动恢复。

插件会在错误信息后附带同样的提示，便于和其他 400 区分。

### OAuth 或模型请求出现 `fetch failed`

检查 DSH Host 能否访问 Google OAuth 和 Antigravity endpoint，再检查代理、证书和网络出口。
不要把 OAuth callback URL、authorization code、access token 或 refresh token 提交到 issue。

## 开发

```bash
npm ci
npm run check
```

主要模块：

- `src/adapter.ts`：DSH LLM 消息与 Antigravity Gemini 请求/SSE 的转换。
- `src/auth.ts`：凭据文件读写、权限设置和 access token 刷新。
- `src/web-auth.ts`、`src/client.tsx`：Web UI OAuth 服务和设置页。
- `src/login.ts`、`src/oauth-callback.ts`：CLI 登录和本机 callback server。

## 发布本地构建包

更新 `package.json` 版本后执行：

```bash
npm run check
npm run pack
```

tarball 会写入 `artifacts/`；该目录中的 `*.tgz` 已被 `.gitignore` 忽略。发布到 GitHub 时，建议
将 tarball 作为 GitHub Release 附件，而不是提交到源码仓库。

## License

MIT
