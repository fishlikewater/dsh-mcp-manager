# dsh-mcp-manager

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的设置页里管理 MCP 服务器。

DSH 原生要在 profile 的 `cordis.patch.yml` 里手写 `@deepseek-ai/dsh-mcp-client` 条目。这个插件把它搬到界面上：填表单、保存，实例随之挂载或卸载，不用改文件、不用重启。模型立刻拿到或失去 `mcp__<名称>__<工具名>` 形式的工具。

支持 DSH 0.1.7-rc.2 及以后，包含桌面版。0.3.0 起配置不再写进 `settings.yaml`，而是本插件 Loader 条目的 `config.servers`。

## 特性

- 在「设置 → MCP 服务器」里增删改查，`stdio` 与 `streamable-http` 都支持
- 每台服务器单独开关。关闭只是不挂载，配置保留
- 保存即生效。`servers` 是 volatile 字段，走就地更新，不重载条目
- 密钥不落盘。`env` / `headers` 的值可以写成 `env:NAME` / `cred:NAME`，挂载时才解析
- 宿主侧不依赖 `webServer`，headless profile 一样能用，只是没有界面

## 安装

插件要同时出现在 profile 的依赖和 `dsh.profile.bundles` 里。本包声明了 `dsh.bundle`，所以 `dsh plugin add` 会一次做完两件事。

### 桌面版

桌面版用应用自带的 profile，路径是 `$DSH_HOME/profiles/desktop`（`$DSH_HOME` 默认是 `~/.dsh`，Windows 上是 `C:\Users\<你>\.dsh`）。它由应用直接加载，不在 CLI 的 profile 列表里，但 `dsh plugin --profile desktop` 照样认得 —— 那个 `--profile` 就是指向 `$DSH_HOME/profiles/<名字>`。

**在侧栏的「插件」页里装**（推荐）。打开「插件」→「添加插件」，填包名、tgz 的绝对路径或者 Git 地址，点「安装」，装完选「立即启用」。对话框里说的「包名」就是下面命令里 `add` 后面那一段；安装失败时页面会给出原因和重试。

**或者命令行走一遍**：

```sh
dsh plugin --profile desktop add @fishlikewater/dsh-mcp-manager
dsh plugin --profile desktop add D:\downloads\fishlikewater-dsh-mcp-manager-0.4.0.tgz
```

两条路做完的是同样两件事：在 profile 目录里跑 pnpm，再按已装状态把声明了 `dsh.bundle` 的包补进 `dsh.profile.bundles`。装完都要重启桌面版，bundle 层只在启动时组合。重启后打开「设置 → MCP 服务器」；条目没出现就是被版本门禁拦下了，见「版本兼容」。

用 `link:` 指向本仓库时，Node 会从插件目录往上找 `@deepseek-ai/*`，可能命中仓库 `node_modules` 里的旧版本。用 tgz 或 npm 包安装可以避开。

### CLI profile

```sh
dsh plugin --profile web add @fishlikewater/dsh-mcp-manager
dsh plugin --profile web add ./path/to/dsh-mcp-manager   # 或本地目录
dsh --profile web --dump-config                          # 能看到 mcp-manager 即可
```

卸载：`dsh plugin --profile web remove @fishlikewater/dsh-mcp-manager`。

## 使用

表格里的字段都能在设置页里填，只有 `toolCallTimeoutMs` 例外：它是条目级的，不是 volatile 字段，只能写进 patch。

| 字段 | 适用 | 说明 |
|---|---|---|
| `serverName` | 全部 | `[A-Za-z0-9_-]{1,32}`，全局唯一，决定工具名前缀 |
| `enabled` | 全部 | 默认 `true` |
| `transport` | 全部 | `stdio` 或 `streamable-http`，默认 `stdio` |
| `command` | stdio | 可执行文件，建议绝对路径 |
| `args` | stdio | 数组，每行一个 |
| `env` | stdio | 每行 `KEY=VALUE`，值可以是数字或布尔，也可以写成 `env:NAME` / `cred:NAME` |
| `cwd` | stdio | 可选 |
| `url` | http | 例如 `http://localhost:3000/mcp` |
| `headers` | http | 每行 `KEY: VALUE`，值同样支持 `env:NAME` / `cred:NAME` |
| `toolCallTimeoutMs` | 条目 | 单次工具调用超时，默认 `60000` |

`serverName` 全局唯一是 `mcp-client` 的要求。重名时本插件只挂第一台，日志里记一条。

改任意一台都会重建全部实例，其余 MCP 连接会重连一次。设置页在可见时每 5 秒对一次 revision，外部改了 patch 会自动反映到界面上。

### 密钥引用

`env` 和 `headers` 的值可以指向别处存着的密钥，配置里只留引用文本：

| 写法 | 取值来源 |
|---|---|
| `env:NAME` | 宿主进程的环境变量 |
| `cred:NAME` | DSH 的 `credentials` 服务，即 `resolve(NAME)` |

引用名限 `[A-Za-z_][A-Za-z0-9_]*`，带连字符的名字不会被当成引用。解析发生在挂载前，交给 `mcp-client` 的配置里是真实值，而 patch 文件和设置页里始终只有引用文本。解析不出来时保留字面值，并在宿主日志里记一条；`credentials` 服务不在时同样如此，不影响其它服务器挂载。

[examples/mcp-servers.example.yaml](examples/mcp-servers.example.yaml) 是一份可以直接抄的配置，`stdio` 和 `streamable-http` 各一。

## 配置写在哪一层

`mcp-manager` 条目由插件自带的 bundle patch 插入。要保存服务器清单，就在 profile 的 `cordis.patch.yml` 里对它做 id 定向覆盖：

```yaml
- id: mcp-manager
  config:
    servers:
      - serverName: demo
        transport: stdio
        command: node
```

两个不要：

- 不要用 `insert:`。bundle 里已经有同名条目，会撞 id。
- 不要写进 `$DSH_HOME/cordis.patch.yml`。home 级 patch 在 profile patch 之后应用、优先级更高，而 DSH 会拒绝任何会被更外层覆盖的表单写入 —— 清单一旦落在 home 层，设置页就变成只读。

代价是每个 profile 各存一份清单，改的时候要改多处。这是「设置写入落在当前 profile 的 patch」带来的结果。

## 版本兼容

DSH 在导入插件前会用运行中的版本检查它的 `peerDependencies`，只看 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 这两类：

- 每个声明的范围都要匹配，预发布版本参与范围匹配
- 没声明的不构成约束
- 范围写法非法一律视为不兼容
- `engines.dsh` 不参与判定

本包声明 `@deepseek-ai/dsh-mcp-client: ^0.1.0-rc.6`。0.x 下 caret 锁 minor，在 DSH 的判定下它覆盖 `0.1.0-rc.6` 到 `0.1.x` 的所有版本，含预发布，但不会跨到 `0.2.0`。

别写死版本枚举。`0.1.0-rc.6 || 0.1.1-rc.2 || 0.1.7-rc.2` 这种写法在 semver 的默认规则下才精确，而 DSH 用的是 `includePrerelease`，枚举反而会漏掉没列出的版本，比如 CLI 侧的 `0.1.2-rc.1`。`>=0.1.0-rc.6 <0.2.0` 也不行，上界会被预发布穿透，连 `0.2.0-rc.1` 都放行。

被门禁拦下时，可以在 `profiles/<profile>/compatibility.json` 里为「包名@版本 × 运行时版本」写一条豁免，由插件管理器的授权流程管理。豁免按精确版本记录，插件升级或 DSH 升级都不继承。

## 工作原理

```text
设置页 client.js（注册在 settings.section 插槽）
  │  ctx.remote.settings.describe() / mutate(ns, ops, expectedRevision)
  ▼
mcp-manager 条目的 config.servers  ←→  profiles/<profile>/cordis.patch.yml
  │  servers 是 volatile 字段，就地更新引用并发 loader/volatile-update
  ▼
宿主半 index.js，逐台 ctx.plugin(mcp-client)，工具注册到 ctx.tools
```

**命名空间就是 Loader 条目 id。** DSH 0.1.7 起用户设置统一成「Loader 条目的 config」，`$DSH_HOME/settings.yaml` 只剩一次性导入的作用，插件自注册的命名空间也不再保证对浏览器可见。所以这里既没有 `ctx.settings.register()`，也没有自建的 HTTP 路由。

**`servers` 必须是 volatile 字段。** settings 服务只把 schema 里带 volatile 字段的活跃条目投影成命名空间：`describe()` 对每个条目求一次 `volatileForm(schema)`，返回 `undefined` 就整条跳过。没有 volatile 字段的插件，命名空间永远不存在。写入也只接受落在 volatile 子树内的路径。

volatile 只能标在固定对象路径上，不能嵌套，所以要整列标在 `servers` 上。标进 `ServerSchema` 内部会被 schemastery 拒绝：

```text
volatile fields require a fixed object path without an enclosing volatile field
```

**volatile 变更不会重载条目。** Loader 只把新快照提交进运行中的引用，然后发 `loader/volatile-update`，`apply` 不重跑。宿主半自己记录已挂载的实例，收到事件先 `dispose()` 再按新值重新挂载。值是 cosmokit 的 `Volatile<T>`，读取要走 `.get()`。

**值按 `any` 接收。** `args`、`env`、`headers` 的值在挂载前统一字符串化。早期版本把 `env` 的值约束成字符串，写一个 `PORT: 8080` 就会让整份 config 校验失败，所有服务器一起挂不上。现在单台写错只影响那一台，日志里记一条 `[dsh-mcp-manager]`。

**`mcp-client` 惰性加载。** 首次需要挂载时才解析模块：先试裸导入，profile 进程里的 runtime 解析拦截会把插件的裸导入路由到宿主自带的那份包；失败则用 `ctx.pluginPackages.packageOf()` 定位包目录，再按绝对路径导入。两条路都落在宿主那一份，避免出现第二个实例抢占 `serverName`。配置为空时完全不加载。

`@deepseek-ai/schemastery` 是普通依赖而不是 peer，静态导入，保证 schema 一定能加载。最低 `^3.18.4`：`.volatile()` 在 3.18.1 还不存在，装到旧版本会在加载时抛 `Schema.array(...).default(...).volatile is not a function`。

## 故障排查

| 现象 | 排查方向 |
|---|---|
| 设置里没有「MCP 服务器」 | 插件不在该 profile 的 bundles 里，或被版本门禁拒绝。看侧栏「插件」页和启动时的 stderr |
| 「没有找到 mcp-manager 配置命名空间」 | 条目 id 不是 `mcp-manager`、条目没被加载，或宿主半的 `Config` 里没有 volatile 字段（0.4.0 之前） |
| 保存被拒绝，页面像只读 | `config.servers` 被更外层的 patch 覆盖，通常是写在了 `$DSH_HOME/cordis.patch.yml` |
| 「配置已被其他写入方改动」 | revision 冲突。页面每 5 秒会自己刷新，重试即可 |
| 换了新版但行为没变 | `index.js` 和 `client.js` 的改动要重启 DSH；config 和 patch 的改动会热生效 |
| 工具列表里没有 `mcp__*` | 该台 `enabled: false`、config 校验失败，或 MCP 服务器自己连不上。在宿主日志里搜 `[dsh-mcp-manager]` 和 `mcp-client(` |
| 提示无法加载 `@deepseek-ai/dsh-mcp-client` | 该 profile 的 runtime 解析拦截没生效，或这个包不在运行时里 |
| 保存后 patch 文件被重排、注释消失 | 设置页按 schema 重写文件，属正常行为 |
| 服务器连不上但配置看着没错 | 值可能写成了 `env:NAME` / `cred:NAME`，而对应的环境变量或凭据没配。宿主日志里搜「引用保留字面值」 |
| 安装命令跑不通 | 手工兜底：在 profile 的 `package.json` 里加依赖、把包名加进 `dsh.profile.bundles`，再 `pnpm install` |

## 开发

```text
package.json            dsh.bundle.patch 与 dsh.client 双 manifest
cordis.patch.yml        bundle 层，插入 mcp-manager 条目
index.js                宿主半：Config schema，逐台挂载 mcp-client
client.js               客户端 bundle，手写维护，不需要打包器
examples/               配置示例
scripts/check-pack.mjs  npm pack 白名单校验
test/                   自测与迁移校验
```

```sh
npm test                               # 宿主半 + 客户端半自测
npm run check:pack                     # 发布内容白名单
python test/verify-profile-patch.py    # 校验两个 profile 的 patch，要能读到 $DSH_HOME
```

`client.js` 是给浏览器模块加载器用的产物，格式是 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须是完整包名 `@fishlikewater/dsh-mcp-manager`：client-modules 按包名匹配 Loader 条目。

改完代码必须重启 DSH。Node 的 ESM 模块缓存不随文件变化失效，浏览器侧的 bundle 同理。

## 发布

```sh
npm publish
```

`prepublishOnly` 会先跑 `npm test` 和 `npm run check:pack`：自测不过，或者 `files` 白名单漏了 `examples/`、混进了 `test/`，发布都会中止。

包名用 scope 版 `@fishlikewater/dsh-mcp-manager`，无 scope 的 `dsh-mcp-manager` 已被他人占用。发布者账号必须是 `fishlikewater`。`publishConfig.access: public` 已经配好，不用带 `--access public`。

改包名要同步三处：`cordis.patch.yml` 的 `name`、`client.js` 的 `id`，以及各 profile 的 `package.json`。

## License

MIT
