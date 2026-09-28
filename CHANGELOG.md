# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.3.5 - 2026-09-28

### 修复

- 传输方式下拉框不跟主题。展开的候选列表是原生控件，不读 CSS 变量，只认 `color-scheme`。外壳虽然把它设在 `<html>` 上，局部容器会覆盖成 light，暗色主题下候选文字和背景就撞在一起。`.mcp-select` 现在显式跟随暗色标记
- 输入框和下拉框的字体不跟周围文字。`input` / `select` 不继承 `font-family`（UA 样式里写死了），会用系统 UI 字体渲染，和 label 对不上。统一补 `font-family: inherit`

### 变更

- placeholder 改用 `--dsw-alias-label-tertiary`，不再吃浏览器默认色
- 弹层投影分主题：浅色 `.18`、暗色 `.5`。原来固定 `.28`，暗色下几乎看不出浮层
- `.mcp-btn-primary` 与开关圆点的 `--dsw-alias-label-primary-foreground` 补上 fallback，和 `.mcp-btn-danger-solid` 保持一致
- `injectUiCss()` 拆出纯函数 `buildUiCss()`，客户端自测新增 8 条断言覆盖主题跟随规则

## 0.3.4 - 2026-09-28

### 新增

- 密钥引用。`env` / `headers` 的值可以写成 `env:NAME`（宿主进程环境变量）或 `cred:NAME`（DSH 的 `credentials` 服务）。解析在挂载前完成，交给 `mcp-client` 的是真实值，patch 和设置页里始终只有引用文本；解析不出来时保留字面值并在宿主日志里记一条，`credentials` 服务不在也不影响其它服务器挂载
- 设置页里两个多行输入框的标签标出这两种写法

### 变更

- 加入 `scripts/check-pack.mjs` 与 `npm test` / `npm run check:pack` 脚本，`prepublishOnly` 会先跑这两步：自测不过，或 `files` 白名单漏文件、混进 `test/` 与 `.github/`，发布中止
- 加入 GitHub Actions：node 18 / 20 / 22 与 `dsh-mcp-client` 0.1.0-rc.6 / 0.1.0-rc.8 / 0.1.1-rc.2 组合跑两半自测，另有一个 job 跑打包校验
- 宿主自测新增 20 条断言，覆盖引用解析、引用名非法、取值失败与 `credentials` 缺失

## 0.3.3 - 2026-09-28

### 变更

- `@deepseek-ai/dsh-mcp-client` 的 peer 范围由版本枚举改为 `^0.1.0-rc.6`。DSH 的兼容门禁用 `includePrerelease` 匹配，caret 范围能覆盖将来所有 `0.1.x`（含预发布）；枚举会漏掉没列出的版本，例如 CLI 侧的 `0.1.2-rc.1`
- `@deepseek-ai/cordis` 的 peer 范围由 `^4.0.1` 收紧到 `^4.0.2`，与当前运行时一致
- 桌面版的安装说明改为走侧栏「插件」页或 `dsh plugin --profile desktop add`，不再要求手改 `package.json`。`dsh plugin` 会在 pnpm 之后按已装状态调和 `dsh.profile.bundles`，桌面版 profile 同样认得
- 精简 `description`：它同时用在插件管理器的安装确认和卡片上

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
