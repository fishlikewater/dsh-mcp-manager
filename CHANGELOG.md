# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.3.3 - 2026-09-28

### 变更

- `@deepseek-ai/dsh-mcp-client` 的 peer 范围由版本枚举改为 `^0.1.0-rc.6`。DSH 的兼容门禁用 `includePrerelease` 匹配，caret 范围能覆盖将来所有 `0.1.x`（含预发布）；枚举会漏掉没列出的版本，例如 CLI 侧的 `0.1.2-rc.1`
- `@deepseek-ai/cordis` 的 peer 范围由 `^4.0.1` 收紧到 `^4.0.2`，与当前运行时一致

## 0.3.2 - 2026-09-28

### 修复

- 桌面版下报「没有找到 mcp-manager 配置命名空间」。原因是 `Config` 里没有 volatile 字段：settings 服务只把带 volatile 字段的活跃条目投影成命名空间，`describe()` 遇到没有的条目直接跳过。`servers` 现在整列标记为 volatile
- volatile 只能标在固定对象路径上。标进 `ServerSchema` 内部会被 schemastery 以 `volatile fields require a fixed object path without an enclosing volatile field` 拒绝
- 取值改走 `.get()`。volatile 字段解析后是 cosmokit 的 `Volatile<T>` 稳定引用，新增 `volatileValue()` 统一解引用并兼容裸值
- 设置页保存后新配置不生效。volatile 变更不会重载条目，`apply` 不重跑；宿主半改为监听 `loader/volatile-update`，先 `dispose()` 旧实例再按新值重新挂载

### 变更

- `@deepseek-ai/schemastery` 由 `^3.18.1` 收紧到 `^3.18.4`。`.volatile()` 在 3.18.1 还不存在，装到旧版本会在加载时抛 `Schema.array(...).default(...).volatile is not a function`

### 注意

- `config.servers` 不能再放在 `$DSH_HOME/cordis.patch.yml`。home 级 patch 在 profile patch 之后应用、优先级更高，DSH 会拒绝被它覆盖的表单写入，设置页会变成只读
- 本版改了 `index.js` 与 `client.js`，装好后要重启 DSH。config 和 patch 的改动仍然热生效

## 0.3.1 - 2026-09-28

### 修复

- 桌面版下报「settings 通道不可用」。0.3.0 写的 `connection.api.settings` 不存在，官方通道是客户端 Remote 命名空间 `ctx.remote.settings`
- 应答结构不是一个多包一层的 `{ result: { ok, value } }`，而是 `{ ok, value }` 或 `{ ok: false, error }`
- `describe()` 无参；写入是 `mutate(ns, ops, expectedRevision)` 三个位置参数，不是单对象入参
- 冲突错误码是 `settings/conflict`，0.3.0 误写成 `SETTINGS_CONFLICT`
- `expectedRevision` 传 `undefined` 表示无条件写入，首次保存不再因本地伪造的 revision 0 而误报冲突

### 变更

- `args`、`env`、`headers` 的值由 `string` 放宽为 `any`，挂载前统一字符串化。以前在 `env` 里写 `PORT: 8080` 会让整个条目的 config 校验失败，所有服务器一起挂不上

## 0.3.0 - 2026-09-28

### 变更

- 配置从插件自注册的 settings 命名空间迁到 Loader 条目的 config。宿主半改为声明 `Config` 加 `apply(ctx, config)`，`servers` 就是 `mcp-manager` 条目的 `config.servers`
- 设置页注册 id 由 `mcp` 改为 `mcp-manager`，与条目 id、settings 命名空间对齐
- 客户端数据通道改用官方 settings remote，带修订栅栏
- `@deepseek-ai/dsh-mcp-client` 改为惰性加载：先试裸导入，失败则用 `ctx.pluginPackages.packageOf()` 定位包目录后按绝对路径导入
- 卡片状态改为配置层语义；实例连接失败改为查宿主日志
- `transport` 缺省按 `stdio` 处理
- `dsh.client` 去掉无意义的空 `inject`

### 移除

- `ctx.settings.register('mcp', …)` 与 `settings/updated` 增量同步
- 宿主侧自建的 `GET/POST /api/mcp/servers` 路由，客户端不再需要 `webServer`

### 注意

- 0.2.x 写在 `$DSH_HOME/settings.yaml` 里 `mcp.servers` 的配置不会被读取，该文件自 0.1.7 起已废弃。请改成 `mcp-manager` 条目的 `config.servers`，或直接在设置页重新添加

## 0.2.0 - 2026-08-14

### 新增

- 每台 MCP 服务器可单独开启或关闭，切换后立即挂载或卸载对应实例，其余服务器不受影响
- 挂载状态新增 `disabled`

### 变更

- 包名改为 `@fishlikewater/dsh-mcp-manager`，无 scope 的 `dsh-mcp-manager` 已被他人占用

## 0.1.0 - 2026-08-14

### 新增

- 首个版本：设置页「MCP 服务器」管理界面 + 宿主侧实例管理器
- 支持 `stdio` 与 `streamable-http` 两种传输
- `dsh.bundle` 与 `dsh.client` 双 manifest，可通过 `dsh plugin add` 安装
