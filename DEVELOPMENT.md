# 开发

面向本仓库的维护者；用户安装与使用见 [README.md](README.md)。

```bash
npm ci
npm run check   # typecheck + vitest + tsdown 构建
npm run pack    # 打包到 artifacts/（*.tgz 已被 .gitignore 忽略）
```

## 模块结构

- `src/adapter.ts`：DSH LLM 消息与 Antigravity Gemini 请求/SSE 的转换，含模型目录发现与归一化。
- `src/auth.ts`：凭据文件读写、权限设置和 access token 刷新。
- `src/web-auth.ts`、`src/client.tsx`：Web UI OAuth 服务和设置页。
- `src/login.ts`、`src/oauth-callback.ts`：CLI 登录和本机 callback server。
- `src/host-audit.ts`：宿主包自检，共享实例被副本遮蔽时在启动日志里报警。

## 宿主契约

插件只对着当前 dsh 发行版开发，不确定的行为都在这里列清楚；宿主 API 变化时按这份清单核对：

| 依赖 | 插件做法 |
| --- | --- |
| `dsh-typert-protocol` 用原型上的标记读取 `@Remote` 方法 | 不自行实现标记读写，只 import 宿主那一份；出现副本会导致 `/api/*` 全线 404 |
| LLM 派发经 `LlmAdapter.prepareCall()` 两步式入口 | 只实现 `stream()`，不覆盖 `prepareCall` |
| tool call id 是 `@deepseek-ai/dsh-llm/brand` 的品牌类型 | 用 `ToolCallId()` 构造，不导入也不自造别名 |
| settings 命名空间只接受字面量（`settingsNamespace()` 已移除） | 使用 `'llm-antigravity-oauth'` 字面量 |
| 前端 `Context` 来自 `@deepseek-ai/cordis`，slot 注册走 `ctx.slots`（由 `dsh-client-ui-renderer` 声明），设置分区契约由 `dsh-client-ui-settings` 声明 | 只做 type-only import，slot 与设置分区按契约注册 |
| `replayState` 是宿主的 `ReplayEnvelope`：`response` 放适配器私有元数据，`blocks` 与消息块一一对应 | 版本头放在 `response` 里；`blocks` 与发出的块数一致，宿主截断时会同步裁剪 |

其中 typert 标记与 `prepareCall` 不是源码层面的适配，而是**模块实例必须唯一**：宿主用自己的
`remoteMethods()` 读标记、用自己的 `LlmAdapter` 基类派发请求，插件一旦 import 到第二份副本就会注册
宿主认不出的类。因此所有 `@deepseek-ai/*` 都是 optional peer，运行时只使用宿主进程里那份；自检对
「无法判断」的情况保持静默，只在能确定解析到副本时报警。

## 跟进宿主新版本

升级 dsh 之后同步抬基线，而不是加兼容分支：

```bash
npm install --save-dev \
  @deepseek-ai/dsh-llm@<new> @deepseek-ai/dsh-typert-protocol@<new> @deepseek-ai/dsh-settings@<new> \
  @deepseek-ai/cordis@<new> @deepseek-ai/schemastery@<new> \
  @deepseek-ai/dsh-client-connection@<new> @deepseek-ai/dsh-client-ui-settings@<new> \
  @deepseek-ai/dsh-client-ui-primitives@<new> @deepseek-ai/dsh-client-ui-renderer@<new>
npm run check
```

`peerDependencies` 与 `peerDependenciesMeta` 里的版本一起改（范围只是基线声明，rc 阶段的语义化范围
并不构成兼容承诺）。`tsc` 只对着 `devDependencies` 解析，`--listFiles` 可以确认它读的是哪一份类型。

验证时用一个干净的 `DSH_HOME` 起宿主，确认：设置分区能渲染、`/api/antigravityAuth/status` 返回 200
而不是 404、`registration.adapter.prepareCall` 是函数。三项都过就说明这一版宿主仍然兼容。

## 发布

更新 `package.json` 版本后：

```bash
npm run check
npm run pack
git tag -a v0.3.2 -m "v0.3.2" && git push origin v0.3.2
gh release create v0.3.2 artifacts/dsh-antigravity-oauth-0.3.2.tgz \
  --title v0.3.2 --notes-file /tmp/release-notes-v0.3.2.md
```

tarball 只作为 Release 附件，不提交到源码仓库。Release 正文用中英双语：中文段按新功能、修复、文档、
兼容性、安装、校验分节，英文段与之一一对应，末尾附 `npm run check` 结果、产物文件名、文件数和
SHA-256。发布后核对附件 digest 与本地一致：

```bash
gh api repos/Eridani075/deepseek-harness-antigravity-oauth/releases/tags/v0.3.2 \
  --jq '.assets[] | .name + " " + .digest'
shasum -a 256 artifacts/dsh-antigravity-oauth-0.3.2.tgz
```

装进 profile 后可以再确认落地的是这一版：安装目录里的 `lib/index.mjs` 应与本地构建的字节一致。
