# dsh-mcp-manager

MCP 服务器管理器：给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个「设置 → MCP 服务器」页面，在界面上配置 MCP（Model Context Protocol）服务器，**保存即生效**——宿主侧自动挂载/卸载 `@deepseek-ai/dsh-mcp-client` 实例，我（模型）随即拿到或失去 `mcp__<名称>__<工具名>` 形式的工具。

无需再手写 `cordis.patch.yml` 里的 MCP 行，也无需重启进程。

## 功能

- 设置页管理：列出 / 新增 / 编辑 / 删除 MCP 服务器，带挂载状态
- 两种传输：`stdio`（本地命令）与 `streamable-http`（远程 URL）
- 配置持久化在 `settings.yaml` 的 `mcp` 命名空间（`mcp.servers`），改动热生效
- 宿主侧按配置动态挂载 `@deepseek-ai/dsh-mcp-client` 实例（断线自动重连、工具自动注册/注销由它负责）
- headless profile 也能用：没有 `webServer` 服务时跳过 HTTP 接口，只做实例管理

## 安装

> 前置：已安装 `dsh` CLI（以及 pnpm；`dsh plugin` 命令转发给 pnpm）。

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-mcp-manager

# 或从本地 checkout 安装
dsh plugin --profile web add ./path/to/dsh-mcp-manager
```

`dsh plugin add` 会把包安装进 profile 的依赖，并因为本包声明了 `dsh.bundle`，自动把 `dsh-mcp-manager` 追加到该 profile 的 `dsh.profile.bundles`（即应用本包的 `cordis.patch.yml` 层）。验证组合树：

```sh
dsh --profile web --dump-config   # 应能看到 mcp-manager 行
```

**重启 dsh 进程后生效**（bundle 层在启动时组合；插件代码改动也需要重启，见下文「开发」）。重启后刷新浏览器页面，打开 设置 → MCP 服务器 即可。

卸载：`dsh plugin --profile web remove dsh-mcp-manager`（同时移除依赖与 bundle 层）。

## 使用

设置页各字段：

| 字段 | 传输 | 说明 |
|---|---|---|
| 名称（serverName） | 两者 | `[A-Za-z0-9_-]{1,32}`，全局唯一，决定工具名前缀 `mcp__<名称>__…` |
| 传输方式 | 两者 | `stdio` / `streamable-http` |
| 命令（command） | stdio | 可执行文件（支持绝对路径）或 `npx` 之类命令 |
| 参数（args） | stdio | 每行一个 |
| 环境变量（env） | stdio | 每行 `KEY=VALUE` |
| 工作目录（cwd） | stdio | 可选 |
| URL | http | 如 `http://localhost:3000/mcp` |
| 请求头（headers） | http | 每行 `KEY: VALUE` |

保存后立即生效；删除后对应工具立即移除。

### 示例

`examples/mcp-servers.example.yaml` 给出了 settings.yaml 中 `mcp` 命名空间的示例（stdio 与 streamable-http 各一）。可以直接把它合并进 `$DSH_HOME/settings.yaml` 作为初始配置，再从设置页调整。

## HTTP 接口（供设置页使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mcp/servers` | 返回 `{ servers, status }`，status 是 `serverName -> { state: 'ok'\|'error', message }` |
| POST | `/api/mcp/servers` | 请求体 `{ servers: [...] }`，整体替换并触发重挂载；校验失败返回 400 `{ error }` |

## 开发

结构：

```
├── package.json       # dsh.bundle.patch + dsh.client 双 manifest
├── cordis.patch.yml   # bundle 层：插入 mcp-manager 行
├── index.js           # 宿主侧：settings 注册 + 实例挂载 + HTTP 接口
├── client.js          # 客户端 bundle（手写 CJS factory，经 ./client 导出）
└── examples/
```

注意：

- **改代码后必须重启 dsh 进程**：Node 的 ESM 模块缓存不会随文件变化失效。配置数据不需要重启（设置页保存即热生效）。
- `client.js` 是给浏览器模块加载器的构建产物（`window.__ModuleLoader__.load` 格式），直接手写维护，不需要打包器。
- 设置页导航图标：外壳按 section id 硬编码图标且没有注册点，本插件用一小段 CSS 覆盖把「MCP 服务器」行的图标换成链接图标；选择器依赖外壳的类名哈希（`VOzbGW_*`），DSH 升级后若失效只会安静地退回默认齿轮图标，不影响功能。
- `@deepseek-ai/dsh-mcp-client` 以 peerDependency 声明，由运行时提供；`@deepseek-ai/schemastery` 为普通依赖。

## 发布

```sh
npm publish
```

（首次发布前确认包名 `dsh-mcp-manager` 未被占用；如需 scope 版，改名并同步修改 `cordis.patch.yml` 里的 `name` 行。）

## License

MIT
