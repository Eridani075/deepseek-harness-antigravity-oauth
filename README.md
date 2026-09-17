# DeepSeek Harness Antigravity OAuth

把 Google Antigravity 账号里的 Gemini 模型接进
[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)，作为原生 LLM provider 使用。

- Provider ID：`antigravity`
- 运行方式：DSH Web profile 插件
- 认证方式：Google OAuth，refresh token 保存在本机

> [!WARNING]
> 本插件调用 Antigravity 的非公开内部 API，不是 Google 官方 Gemini API 集成，与 Google、DeepSeek、
> Antigravity 官方均无隶属或赞助关系。使用可能违反 Google 服务条款并导致账号受限或封禁，请自行评估
> 风险，不要使用重要账号；接口可能随时失效，作者不保证长期可用性。请勿将 OAuth callback URL、
> authorization code、access token、refresh token 或任何其他敏感信息提交到 issue、日志、截图或公开仓库。

## 功能

- Gemini 文本生成、thinking、tool calls / tool results，流式响应与 usage
- 图像输入：图片附件以 Gemini `inlineData` 内联发送
- Web UI 设置页直接唤起 Google 登录并自动接收本机 OAuth callback
- 自动刷新 token、失败重试；Models 设置页可删除/恢复 provider

不支持 PDF 输入和多账号轮换（DSH 附件通道只保存位图，没有 PDF 内容块可下发）；图像生成模型不会注册
到模型选择器。

## 模型

登录后插件调用上游 `v1internal:fetchAvailableModels` 获取当前账号可用的模型，并与内置列表合并。
内置列表用于未登录或上游不可达时的回退，因此选择器不会为空：

```text
antigravity-gemini-3.7-flash
antigravity-gemini-3.6-flash
antigravity-gemini-3.5-flash
antigravity-gemini-3.1-pro
```

上游新增 Gemini 文本模型（`*-pro` / `*-flash`）时选择器里会自动出现，不需要更新插件。模型名去掉
`antigravity-` 前缀后就是请求使用的 model id；`-preview`、`-tiered`、`-low/-medium/-high` 等后缀会
归一化，tier 通过 reasoning effort 选择。只注册「插件实际会发送的 wire id 在上游目录里存在」的模型，
所以显示名一定对应真正被调用的模型；图像生成、Claude、gpt-oss 等上游条目不在本插件范围内。

结果缓存 15 分钟；查询失败时回退内置列表，并在 60 秒内不再重试，避免模型选择器卡在网络上。

`*-pro` 支持 `low` 和 `high` reasoning effort；其他模型支持 `low`、`medium` 和 `high`。

## 兼容性

**只支持当前 dsh 发行版**：Node.js 20 或更高版本，宿主需为 `0.1.5-rc` 线（开发与验证基线：`dsh` CLI
`0.1.5-rc.1`，`@deepseek-ai/dsh-*@0.1.5-rc.2`）。dsh 还在测试阶段，每个 rc 都可能破坏插件，本项目不为
旧宿主保留兼容分支：宿主升级时跟着升级插件；还停在 `0.1.0-rc.x` 宿主的请先升级 dsh 本身。

宿主提供的包（`@deepseek-ai/*`）在 `package.json` 里全部是 **optional** peer dependency，插件运行时只
import 宿主进程里的那一份，不会随插件安装自己的副本——副本会让宿主认不出插件注册的类（见「故障排查」）。

OAuth 和 transport 由 [cortexkit/antigravity-auth](https://github.com/cortexkit/antigravity-auth) 提供。

## 安装

### 使用预构建包

打开 [GitHub Releases](https://github.com/Eridani075/deepseek-harness-antigravity-oauth/releases/latest)，
在 Assets 中下载 `dsh-antigravity-oauth-*.tgz`，然后安装下载的文件：

```bash
dsh plugin --profile web add "/absolute/path/to/dsh-antigravity-oauth-VERSION.tgz"
dsh --profile web --dump-config
```

`--dump-config` 输出中应出现 `dsh-antigravity-oauth` bundle 和 `llm-antigravity-oauth` 条目。安装或升级
插件后重启已经运行的 DSH Web 服务再刷新浏览器；已经有服务占用 `127.0.0.1:3080` 时不要启动第二个
`dsh web`。

### 从源码构建

```bash
npm ci
npm run check
npm run pack
```

产物位于 `artifacts/`，再按上面的命令安装生成的 tarball。

### 注意事项

- 用 pnpm 9 时 `add` 需要显式加 `-w`（pnpm 会把 profile 当成 workspace root 并拒绝安装）：
  `dsh plugin --profile web add -w "<tgz>"`。
- 安装时 pnpm 可能提示缺少 `hono`、`arctic`（`@cortexkit/antigravity-auth-core` 的传递依赖），它们不在
  本插件使用的 OAuth/transport 路径上，bundle 能正常加载就不必理会。
- 插件的 DSH peer dependency 全部是 optional，pnpm 和 npm 都不会自动安装，也不会出现「缺少 DSH peer
  dependencies」这类提示。

## 登录

### Web UI

Settings → Antigravity →「登录 Google」，完成授权即可，插件会在 DSH Host 侧监听本机 OAuth callback 并
自动保存凭据，正常情况下不需要手动复制 code。浏览器阻止新标签页时，页面会提供一次性的「打开授权页面」
按钮。

### CLI

```bash
dsh plugin --profile web exec dsh-antigravity-login
```

CLI 监听 `127.0.0.1:51121` 并打印 Google OAuth URL；授权完成后 callback 自动交给 CLI，自动 callback 失败
时可以粘贴完整 callback URL 或 authorization code。

凭据默认保存到 `${DSH_HOME:-~/.dsh}/antigravity-oauth.json`（POSIX 上权限为 `0600`），可用
`DSH_ANTIGRAVITY_AUTH_FILE` 指定其他路径。

## 使用与凭据管理

在模型选择器中选择 `antigravity` provider 及上述模型 ID。

- **删除或恢复 provider**：Settings → Models 里的 Google Antigravity 使用 DSH 原生 Delete 操作，会移除
  provider 配置并停用 adapter，但保留 OAuth 凭据；Settings → Antigravity 的「启用提供商」可以恢复，
  无需重新登录。
- **退出登录**：Settings → Antigravity →「退出登录」删除本机凭据文件，但不会撤销 Google 账号侧的应用
  授权；再次使用模型前需要重新登录。

## 故障排查

### 模型没有出现在模型选择器

确认插件装到了当前使用的 profile，并检查 `dsh --profile web --dump-config` 的输出包含
`dsh-antigravity-oauth` 和 `llm-antigravity-oauth`，然后重启 DSH Web 服务并重新打开 Settings → Models。

### 登录按钮报 HTTP 404，或 `registration.adapter.prepareCall is not a function`

两个报错是同一个原因：插件的 `node_modules` 里存在第二份 `@deepseek-ai/dsh-*`，插件 import 的是旧副本，
宿主认不出它注册的类——Remote 方法标记落在旧副本里，`/api/antigravityAuth/*` 全部 404；旧副本的基类没有
`prepareCall()`，模型调用直接抛错。插件加载时会自检这两个包，解析到非宿主副本时直接写进启动日志并点名
版本和路径。加载时若没有告警，就不是这个问题。

检查 profile 里有没有第二份副本：

```bash
ls "${DSH_HOME:-$HOME/.dsh}"/profiles/web/node_modules/.pnpm/node_modules/@deepseek-ai 2>/dev/null
```

有输出就是中招；升级到 0.4.0 或更高版本重装即可（peer 已是 optional，副本会在重装时被清掉）。同一个
版本号重装时 pnpm 会报 “Already up to date” 而不重新解析依赖，需要先删掉 profile 里的插件目录和
`pnpm-lock.yaml` 中对应的条目。

### 启动时报 `does not provide an export named ...`

dsh 在 rc 之间会重命名或移除导出。插件只对当前宿主版本开发，这类报错的处理方式是**升级插件**（尤其是
升级 dsh 之后出现的）；仍报错时在 issue 中附上 `dsh --version` 和完整报错，不要附带任何 OAuth 凭据。

### `Antigravity token exchange failed: fetch failed` 或其他网络错误

浏览器能打开 Google 授权页不代表 DSH 宿主机进程也能访问这些域名，两者出口可能不同。宿主机必须能访问：

- `oauth2.googleapis.com`：换取和刷新 token，必需
- `cloudcode-pa.googleapis.com` 或 `daily-cloudcode-pa.sandbox.googleapis.com`：模型请求，必需

`www.googleapis.com` 只用于显示账号邮箱，不可达只会导致不显示邮箱。验证连通性：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://oauth2.googleapis.com/token
curl -sS -o /dev/null -w "%{http_code}\n" https://cloudcode-pa.googleapis.com/
```

### `User location is not supported for the API use`

这是 Google 对**请求出口**的地区限制，判断依据是 DSH 宿主机进程的出口 IP，而且限制按节点而非按国家
生效：同一个国家不同机房的节点可能一个被拒、一个正常。遇到时先确认出口（`curl -sS https://ipinfo.io/json`），
再固定一个能通过的节点（关闭自动测速/轮换），或给 DSH 显式指定代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=127.0.0.1,localhost dsh web
```

换节点后仍报同样的错说明该节点出口被拒绝，重试不会自动恢复。插件会在错误信息后附带同样的提示。

### `EADDRINUSE: 127.0.0.1:3080` / `127.0.0.1:51121`

端口已被占用：前者是已有 DSH Web 服务在跑（刷新已有页面即可，需要加载新插件版本时重启旧服务），后者是
旧的 `dsh-antigravity-login` 还活着，退出后重试。

### `Antigravity image input requires the host attachment service`

宿主没有提供 attachment service，插件无法读取图片字节。确认当前 DSH 版本包含该服务（Web profile 默认
包含），并确认图片仍在 attachment 存储中；附件被清理等底层原因会一并写在错误信息里。

## 开发

开发、宿主契约、升级基线步骤和发布流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

MIT
