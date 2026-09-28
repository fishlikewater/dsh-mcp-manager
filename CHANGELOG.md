# Changelog

## 0.3.2

修正 0.3.1 在桌面版下报「没有找到 mcp-manager 配置命名空间」的问题 —— 根因是本插件的 `Config` 里**没有任何 volatile 字段**：

- **`servers` 改为 volatile 字段**：DSH 的 settings 服务只把「schema 里带 volatile 字段」的活跃条目投影成配置命名空间（`describe()` 对每个条目跑 `volatileForm(schema)`，返回 `undefined` 就整条跳过），写入也只接受路径落在 volatile 子树内的操作。没有 volatile 字段 ⇒ 命名空间永远不存在 ⇒ 设置页必然报「没有找到 mcp-manager 配置命名空间」
- **volatile 只能标在固定对象路径上**：`servers` 必须整列标（`Schema.array(ServerSchema).default([]).volatile()`）。若改到 `ServerSchema` 内部标，schemastery 的 `validateVolatileSchema` 会以「volatile fields require a fixed object path without an enclosing volatile field」拒绝整份配置
- **取值改走 `.get()`**：volatile 字段解析后是 cosmokit 的 `Volatile<T>` 稳定引用（`createVolatile()` 冻结快照、`updateVolatile()` 就地提交新快照），新增 `volatileValue()` 统一解引用，并兼容未经 schema 解析的裸值
- **新增 `loader/volatile-update` 重挂载**：volatile 变更**不会重载条目**（Loader 只把新值提交进运行中的引用），`apply` 不会重跑 —— 宿主半改为记录已挂载的 mcp-client fiber，收到该事件时先 `dispose()` 旧实例、再按新值重新挂载。少了这一步，设置页保存后新配置不会生效
- `dependencies` 的 `@deepseek-ai/schemastery` 由 `^3.18.1` 收紧到 `^3.18.4`：`.volatile()` 在 3.18.1 尚不存在，装到旧版会在加载时抛 `Schema.array(...).default(...).volatile is not a function`
- 宿主半自测新增 `[H]` 用例：用 cosmokit 的 `createVolatile` / `updateVolatile` 模拟 Loader 的就地提交，端到端验证「引用被更新 → 触发事件 → 旧实例 dispose → 按新值重挂载」

> 部署提示：`config.servers` 不要再放在 `$DSH_HOME/cordis.patch.yml`。home 层 patch 在 profile patch **之后**应用、优先级更高，而 DSH 对「会被 home patch / 命令行覆盖层盖住的表单写入」直接拒绝 —— 配置放在 home 层会让设置页变成只读。请把服务器清单写进各 profile 自己的 `profiles/<profile>/cordis.patch.yml`。
>
> 重启边界：本版改了 `index.js` / `client.js`，装好后必须**重启 DSH** 才生效；而 config / patch 层面的改动（含设置页保存）由 `patchReload: "live"` 热生效，不必重启。另外，bundle 自带的 `- insert: mcp-manager` 只在启动时组合进树，运行中改 patch 不会补插它 —— 若发现运行清单 `cordis.yml` 里没有该条目，重启即可恢复。

## 0.3.1

修正 0.3.0 的客户端数据通道（0.3.0 在桌面版下必然报「settings 通道不可用」而加载失败）：

- **通道名修正**：0.3.0 写的 `connection.api.settings` 并不存在 —— DSH 0.1.7-rc.2 的官方 settings 通道是客户端 Remote 命名空间 `ctx.remote.settings`，插件需在 `inject` 里声明 `remote` 与 `remote.settings`（`connection` 服务里没有 `api.settings`）
- **应答结构修正**：不是 `{ result: { ok, value } }` 多包一层，而是直接 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`
- **调用签名修正**：`describe()` 无参；写入是 `mutate(ns, ops, expectedRevision)` 三个位置参数，不再是单对象入参
- **修订栅栏修正**：`expectedRevision` 传 `undefined` 表示无条件写入（首次保存不再因本地伪造的 revision 0 而误报冲突）；冲突错误码是 `settings/conflict`（0.3.0 误写成 `SETTINGS_CONFLICT`）
- 命名空间视图按官方 `namespaceView` 取字段：`{ ns, value, revision, schema, … }`
- **值容器放宽**：`args` / `env` / `headers` 的 schema 由 `string` 放宽为 `any`，并统一在翻译阶段字符串化 —— 以前在 `env` 里写 `PORT: 8080`（数字）会让**整个条目**的 config 校验失败，连带所有服务器一起不挂载

## 0.3.0

适配 DSH 0.1.7-rc.2 与桌面版（Desktop profile）的设置模型，配置从「插件自注册的 settings 命名空间」迁到「Loader 条目的 config」：

- 宿主半改为声明 `Config`（schemastery schema）+ `apply(ctx, config)`：`servers` 列表就是 `mcp-manager` 条目的 `config.servers`，config 变化 → 条目重载 → 按新配置挂载/卸载 `mcp-client` 实例
- 删除 `ctx.settings.register('mcp', …)` 与 `settings/updated` 增量同步（0.1.7 起 `$DSH_HOME/settings.yaml` 已废弃，且插件自注册的命名空间不再保证对客户端可见）
- 删除宿主侧自建 HTTP 路由 `GET/POST /api/mcp/servers`（客户端不再需要 `webServer`）
- 客户端数据通道改为官方 settings remote：`connection.api.settings.describe({})` 读取、`mutate({ ns, ops, expectedRevision })` 写入，带修订栅栏（冲突提示刷新重试）
- 设置页注册 id 由 `mcp` 改为 `mcp-manager`，与条目 id / settings 命名空间对齐
- 卡片状态改为配置层语义（「已开启 / 已关闭」）；实例连接失败改为看宿主日志（宿主不再回传挂载状态）
- `peerDependencies` 的 `@deepseek-ai/dsh-mcp-client` 由 `^0.1.0-rc.6` 改为显式版本列表 `0.1.0-rc.6 || 0.1.1-rc.2 || 0.1.7-rc.2`：semver 的预发布规则下范围写法接受不了新版本，且 DSH 的 Plugin Manager 按精确版本做兼容门禁
- `dsh.client` 去掉无意义的空 `inject`；补充 README.md
- 宿主半不再在顶层静态导入 `@deepseek-ai/dsh-mcp-client`，改为首次需要挂载时惰性加载：先试裸导入（由 profile 的 runtime 解析拦截路由到宿主自带的那一份包），失败时用 `ctx.pluginPackages.packageOf()` 定位包目录再按绝对路径导入 —— 两条路都落在宿主那一份，不会产生重复实例；配置为空时完全不触发加载
- `transport` 缺省按 `stdio` 处理（条目 config 未经 schema 填充时同样正确），并补上宿主半逻辑自测

> 升级提示：0.2.x 写在 `$DSH_HOME/settings.yaml` 里 `mcp.servers` 的配置不会被 0.3.0 读取（该文件在 0.1.7 起已废弃）。请把服务器条目改成 `mcp-manager` 条目的 `config.servers`，或直接在设置页「MCP 服务器」里重新添加。

## 0.2.0

- 每台 MCP 服务器可单独开启/关闭：卡片上的开关按钮立即挂载/卸载对应实例，其余服务器不受影响
- 开关状态持久化在 `mcp.servers[].enabled`（默认 `true`），重启 dsh 后保持
- 挂载状态新增 `disabled`（已关闭）；实例按配置差异重建，未变化的服务器不再重连
- 包名改为 scoped 版 `@fishlikewater/dsh-mcp-manager`（无 scope 的 `dsh-mcp-manager` 已被他人占用），`cordis.patch.yml` 的 `name` 同步更新

## 0.1.0

- 首个版本：设置页「MCP 服务器」管理界面 + 宿主侧实例管理器
- settings 命名空间 `mcp.servers` 持久化，保存即热生效
- 支持 stdio 与 streamable-http 两种传输
- `dsh.bundle` 与 `dsh.client` 双 manifest，可通过 `dsh plugin add` 安装
