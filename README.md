# @fishlikewater/dsh-mcp-manager

MCP 服务器管理器：给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个「设置 → MCP 服务器」页面，在界面上配置 MCP（Model Context Protocol）服务器，**保存即生效**——宿主侧按配置挂载/卸载 `@deepseek-ai/dsh-mcp-client` 实例，模型随即拿到或失去 `mcp__<名称>__<工具名>` 形式的工具。

面向 DSH **0.1.7-rc.2 及以后**（含桌面版 Desktop profile）。0.3.0 起配置不再写进 `settings.yaml`，而是本插件 Loader 条目的 `config.servers`（详见「[配置存储与设置通道](#配置存储与设置通道)」）。

## 功能

- 设置页管理：列出 / 新增 / 编辑 / 删除 MCP 服务器，表单字段随传输方式显隐、带字段级校验与工具前缀预览
- 每台服务器可单独开启/关闭（`enabled` 开关）：关闭即不挂载该实例、工具消失，配置保留
- 两种传输：`stdio`（本地命令）与 `streamable-http`（远程 URL）
- 配置持久化为 `mcp-manager` 条目的 `config.servers`（volatile 字段），保存即就地生效、无需重启进程
- 宿主侧挂载 `@deepseek-ai/dsh-mcp-client` 实例（断线重连、工具注册/注销由它负责）
- 宿主半不依赖 `webServer`：任何 profile（含 headless）都能挂载实例，设置页只在有 GUI 的载体里出现

## 安装

插件既要在 profile 的依赖里，也要在该 profile 的 `dsh.profile.bundles` 列表里。

### CLI profile

> 前置：已安装 `dsh` CLI（以及 pnpm；`dsh plugin` 命令转发给 pnpm）。

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add @fishlikewater/dsh-mcp-manager

# 或从本地 checkout 安装
dsh plugin --profile web add ./path/to/dsh-mcp-manager
```

`dsh plugin add` 会把包装进 profile 依赖，并因为本包声明了 `dsh.bundle`，自动把 `@fishlikewater/dsh-mcp-manager` 追加到该 profile 的 `dsh.profile.bundles`。验证组合树：

```sh
dsh --profile web --dump-config   # 应能看到 mcp-manager 行
```

卸载：`dsh plugin --profile web remove @fishlikewater/dsh-mcp-manager`。

### 桌面版（Desktop profile）

桌面版使用应用保留的 profile —— `$DSH_HOME/profiles/desktop`
（Windows：`C:\Users\<你>\.dsh\profiles\desktop`）。它由应用通过 `loadProfileDirectory`
加载，**不会**出现在 CLI 的 profile 列表里，因此要在该目录里手动安装：

1. 编辑 `profiles/desktop/package.json`，加入依赖与 bundle：

   ```json
   {
     "dependencies": {
       "@fishlikewater/dsh-mcp-manager": "file:dsh-mcp-manager-0.3.2.tgz"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@fishlikewater/dsh-mcp-manager"
         ]
       }
     }
   }
   ```

2. 在该目录执行 `pnpm install`（该 profile 的 `pnpm-workspace.yaml` 固定了
   `nodeLinker: hoisted`、`autoInstallPeers: false`）；
3. **重启桌面版**（bundle 层在启动时组合）；
4. 到「设置 → 插件」确认插件没有被版本兼容门禁拦下；
5. 打开「设置 → MCP 服务器」。

**重启 dsh / 桌面版后生效**（bundle 层在启动时组合；插件代码改动也需要重启，见「[开发](#开发)」）。配置数据本身不需要重启。

## 使用

设置页各字段：

| 字段 | 传输 | 说明 |
|---|---|---|
| 名称（serverName） | 两者 | `[A-Za-z0-9_-]{1,32}`，唯一，决定工具名前缀 `mcp__<名称>__…` |
| 传输方式 | 两者 | `stdio` / `streamable-http` |
| 命令（command） | stdio | 可执行文件（建议绝对路径）或 `npx` 之类命令 |
| 参数（args） | stdio | 每行一个 |
| 环境变量（env） | stdio | 每行 `KEY=VALUE`，值可写数字或布尔 |
| 工作目录（cwd） | stdio | 可选 |
| URL | http | 如 `http://localhost:3000/mcp` |
| 请求头（headers） | http | 每行 `KEY: VALUE`，值可写数字或布尔 |

保存后宿主立即按新配置重挂载；删除后对应工具移除。卡片上的开关切换 `enabled`
（默认 `true`）：关闭的服务器只是不被挂载，配置保留、随时可开。

> 注意：重挂载会重建**全部**实例（不是只重建变化的那一台），因此改任意一台都会让
> 其余 MCP 连接重连一次。`servers` 是 volatile 字段，保存走的是「就地更新运行中的
> 引用 + `loader/volatile-update` 通知」，宿主半据此自行卸载再挂载。

### 示例

[examples/mcp-servers.example.yaml](examples/mcp-servers.example.yaml) 给出了 `mcp-manager`
条目 `config` 的示例（stdio 与 streamable-http 各一），可合并进当前 profile 的
`profiles/<profile>/cordis.patch.yml`。

### 服务器清单该写在哪一层

`mcp-manager` 条目由插件自带的 bundle patch 插入（bundles 层），所以在 profile 的
`cordis.patch.yml` 里对它做 **id 定向 config 覆盖**即可，且**不要**用 `insert`
（那会和 bundle 已有的条目撞 id）：

```yaml
- id: mcp-manager
  config:
    servers:
      - serverName: demo
        transport: stdio
        command: node
```

**不要**写到 `$DSH_HOME/cordis.patch.yml`（机器级 patch）。它的应用顺序在 profile patch
**之后**、优先级更高，而 DSH 对「会被 home patch / 命令行覆盖层盖住的表单写入」直接
拒绝 —— 配置一旦落在这一层，设置页里保存 `servers` 就会失败，页面等于只读。

需要跨 profile 共用清单时，请改用设置页里的复制，或接受「每个 profile 各存一份」：
这是 DSH 0.1.7 起「设置写入落在当前 profile 的 patch」这一模型的直接结果。

## 配置存储与设置通道

```text
设置页（client.js，slot settings.section）
   │  ctx.remote.settings.describe()  /  mutate(ns, ops, expectedRevision)
   ▼
mcp-manager 条目的 config.servers   ←→  当前 profile 的 cordis.patch.yml（宿主负责持久化）
   │  servers 是 volatile 字段 → 就地更新引用 → loader/volatile-update
   ▼
宿主半（index.js）apply(ctx, config) → 逐台 ctx.plugin(mcp-client) → ctx.tools 注册工具
   ▲  收到 volatile-update：dispose 旧实例 → 按新值重新挂载
```

设计要点：

- **设置命名空间就是 Loader 条目 id**（`mcp-manager`）。DSH 从 0.1.7 起把用户设置统一成
  「Loader 条目的 config」，`$DSH_HOME/settings.yaml` 只用于一次性导入旧数据；
- 插件**自注册**的额外命名空间不再保证对浏览器可见（宿主 api-proxy 有白名单门控），
  所以这里不再用 `ctx.settings.register('mcp', …)`，也不再自建 HTTP 路由；
- 写入带 `expectedRevision` 修订栅栏：并发写入会得到 `settings/conflict`，页面提示刷新重试；
- 客户端半依赖 `slots`、`remote`、`remote.settings` 三个能力（写在自己的 `inject` 里），
  经 `ctx.remote.settings` 读写：`describe()` 无参返回 `{ ok, value:{ namespaces:[…] } }`，
  写入是 `mutate(ns, ops, expectedRevision)`（`expectedRevision` 传 `undefined` 即无条件写）；
- 可写性由宿主判定（例如远端 Web 可能只读），不可写时保存会直接报错。

宿主半的 `Config` schema 对所有字段都给了默认值，并且 `args` / `env` / `headers` 的**值**
按 `any` 接收、挂载前统一字符串化：某一条服务器配置写错只会让那一台被跳过并在日志里记一条
`[dsh-mcp-manager] …`，不会让整个条目加载失败。早期版本的 `env` 值被约束为字符串，
在里面写一个 `PORT: 8080` 就会让整份配置校验失败 —— 所有服务器一起不挂载。

**`servers` 必须声明为 volatile 字段**（`Schema.array(ServerSchema).default([]).volatile()`）。
这是本插件能被设置页列出、并能写回的两个硬前提：

- settings 服务只把「schema 里带 volatile 字段」的活跃条目投影成配置命名空间 ——
  `describe()` 对每个条目求一次 `volatileForm(schema)`，返回 `undefined` 就整条跳过。
  一个 volatile 字段都没有的插件，命名空间**永远不存在**，设置页只会报
  「没有找到 mcp-manager 配置命名空间」；
- 写入只接受路径落在 volatile 子树内的操作，非 volatile 字段的表单写入会被拒绝。

volatile 的约束是「固定对象路径、且不能嵌套」，所以只能整列标在 `servers` 上；标进
`ServerSchema` 内部会被 schemastery 的 `validateVolatileSchema` 以
`volatile fields require a fixed object path without an enclosing volatile field` 拒绝。

代价是 **volatile 变更不会重载条目**：Loader 只把新快照提交进运行中的引用
（`updateVolatile`），然后 emit `loader/volatile-update`，`apply` 不会重跑。因此宿主半
自己记录已挂载的 mcp-client fiber，收到该事件时先 `dispose()` 旧实例、再按新值重新挂载。
volatile 字段的值是 cosmokit 的 `Volatile<T>` 稳定引用，读取必须走 `.get()`
（宿主半由 `volatileValue()` 统一处理，并兼容未经 schema 解析的裸值）。

## 桌面版注意事项

1. **core 版本要落在 peer 范围内**：桌面版内置的 DSH 包版本必须被本包
   `peerDependencies` 覆盖。`@deepseek-ai/dsh-mcp-client` 已写成显式版本列表
   （`0.1.0-rc.6 || 0.1.1-rc.2 || 0.1.7-rc.2`）——semver 的预发布规则下
   `^0.1.0-rc.6` 这类范围写法接受不了 `0.1.7-rc.2`，而 Plugin Manager 的兼容门禁
   按精确版本判定。桌面版升级到未列出的版本时会被拒绝加载，这是预期行为：
   可以在 `profiles/desktop/compatibility.json` 里为「包名@版本 × 运行时版本」做豁免
   （Plugin Manager 的授权流程），或者更新本包。
2. **不要用插件仓库里的 DSH 副本**：以 `link:` 安装时，Node 会从插件目录向上解析
   `@deepseek-ai/*`；如果本仓库的 `node_modules` 里放着旧版（例如开发期的
   `dsh-mcp-client@0.1.0-rc.6`），宿主会加载到**旧版 bridge** 而不是桌面版自带的
   0.1.7-rc.2。要么删掉这些副本（只保留 `peerDependencies` 声明），要么以 npm 包
   形式安装插件。
3. **与 home 级 patch 去重**：`$DSH_HOME/cordis.patch.yml` 里手工插入的
   `@deepseek-ai/dsh-mcp-client` 条目对**所有** profile 生效。`mcp-client` 要求
   `serverName` 全局唯一，同名会在本插件里挂载失败 —— 迁移到本插件管理时，
   请删除 home patch 里的对应条目。
4. **stdio 命令建议绝对路径**：宿主会清洗子进程环境（含 `DSH_*` 变量），裸命令名
   依赖 PATH，桌面版下更易失败。
5. **导航图标**：设置面板导航行没有图标注册点（外壳按 section id 硬编码）。本插件用
   文本锚点 + `MutationObserver` 自适应绘制链接图标，不依赖外壳类名；找不到时安静
   退回默认齿轮，不影响功能。

## 故障排查

| 现象 | 排查 |
|---|---|
| 设置里没有「MCP 服务器」 | 插件不在该 profile 的 `bundles` 里，或被版本门禁拒绝（看「设置 → 插件」与启动 stderr 的 `skippedBundles`） |
| 页面提示「没有找到 mcp-manager 配置命名空间」 | 条目 id 不是 `mcp-manager`；条目未被加载；或宿主半 `Config` 里**没有任何 volatile 字段**（0.3.1 及更早版本的 bug，0.3.2 起 `servers` 已标 volatile） |
| 保存报「配置已被其他写入方改动」 | 修订冲突（`settings/conflict`）：点刷新后重试 |
| 保存被拒绝 / 页面像是只读 | `config.servers` 被更外层的 patch 覆盖（最常见是写在了 `$DSH_HOME/cordis.patch.yml`）：DSH 拒绝会被覆盖层盖住的表单写入，把清单移到 profile 的 `cordis.patch.yml` |
| 换了新版但行为没变 | 插件代码（`index.js` / `client.js`）变更需要**重启 DSH**；只有 config / patch 层面的改动才会热生效。另外运行清单 `cordis.yml` 里若没有 `mcp-manager` 条目，也重启即可恢复（bundle 的 `insert` 只在启动时组合） |
| 工具里没有 `mcp__*` | 该台 `enabled: false`、配置校验失败，或 MCP 服务器自身连接失败 —— 在宿主日志里搜 `[dsh-mcp-manager]` 与 `mcp-client(` |
| 工具名带 12 位哈希后缀 | 名称过长或含非法字符时 `mcp-client` 的规范化行为（正常） |
| 日志出现「无法加载 `@deepseek-ai/dsh-mcp-client`」 | 该 profile 的 runtime 解析拦截没生效（core 版本过旧，或该包不在运行时包里）。先看「设置 → 插件」里本插件的状态 |

## 开发

结构：

```
├── package.json       # dsh.bundle.patch + dsh.client 双 manifest
├── cordis.patch.yml   # bundle 层：插入 mcp-manager 行
├── index.js           # 宿主半：Config schema + 逐台挂载 mcp-client
├── client.js          # 客户端 bundle（手写 CJS factory，经 ./client 导出）
├── examples/
└── README.md
```

注意：

- **改代码后必须重启 dsh / 桌面版**：Node 的 ESM 模块缓存不会随文件变化失效。
  配置数据不需要重启（保存即热生效）。
- `client.js` 是给浏览器模块加载器的产物（`window.__ModuleLoader__.load` 格式），
  手写维护、不需要打包器；其 `id` 必须是完整包名
  `@fishlikewater/dsh-mcp-manager`（client-modules 按包名匹配 Loader 行）。
- `@deepseek-ai/dsh-mcp-client` 以 peerDependency 声明，由运行时提供；
  `@deepseek-ai/schemastery` 为普通依赖（静态导入，保证 `Config` schema 一定能加载），
  版本下限 **`^3.18.4`**：`.volatile()` 在 3.18.1 还不存在，装到旧版会在加载时抛
  `Schema.array(...).default(...).volatile is not a function`。
- mcp-client 是**惰性加载**的：首次真正需要挂载实例时才解析模块。先试裸导入 ——
  桌面版与 CLI 都会在 profile 进程里安装 runtime 解析拦截，把 profile 内插件的裸导入
  路由到宿主自带的那一份包；拦截不可用时回退到 `ctx.pluginPackages.packageOf()`
  定位包目录、再按绝对路径导入。两条路都落在宿主那一份，避免出现第二个 mcp-client
  实例互相抢占 `serverName`。
- 宿主半逻辑自测：`node test/host.selftest.mjs`（假 ctx，覆盖空配置、坏配置、两种传输、重复名、
  缺省字段、值容器字符串化，以及 volatile 引用的读取与 `loader/volatile-update` 触发的重挂载）；
- 客户端半通道自测：`node test/client.selftest.mjs`（假 module loader + 假 Remote，覆盖通道缺失、
  `describe` 命中/未命中/被拒绝、`mutate` 的调用签名与 `settings/conflict` 冲突提示）。
  这一层出过「通道名写错」的错，所以对官方契约本身做回归是有意义的。

## 发布

```sh
npm publish
```

> 包名使用 scope 版 `@fishlikewater/dsh-mcp-manager`：无 scope 的 `dsh-mcp-manager` 已被他人占用。发布者的 npm 账号必须是 `fishlikewater`（scope 归属），`publishConfig.access: public` 已配置，无需 `--access public`。改包名时需同步修改 `cordis.patch.yml` 里的 `name` 行与 `client.js` 里的 `id`。

## License

MIT
