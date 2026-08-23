# Changelog

## 0.2.1

- 作者邮箱更新为 fishlijewater@126.com，package.json 增加 `engines.node >= 18`
- 新增兼容性测试套件（`npm test`，node:test 零依赖）：宿主纯逻辑单测、客户端 bundle vm 沙箱测试、真实 `dsh-mcp-client` Config 契约测试、内存 Cordis + 假 stdio MCP 服务器的端到端冒烟测试
- 新增 CI（GitHub Actions）：Node 18/20/22 × dsh-mcp-client 0.1.0-rc.6 / 0.1.0-rc.8 / 0.1.1-rc.2 版本矩阵 + npm pack 发布内容校验
- 纯逻辑抽到 `lib/logic.js`，`client.js` 导出解析/组装助手供测试复用，行为不变

功能/可靠性改进：

- 真实挂载状态：截获 mcp-client 日志（logger exporter）把异步连接失败/重连/放弃/工具注册失败实时反映到设置页状态，不再只显示乐观「已挂载」
- 并发保存保护：HTTP 接口携带 `rev` 修订号（乐观锁），配置被其他窗口改过时返回 409，客户端提示刷新，不再静默覆盖
- 修复快速卸载/重挂同一 serverName 的竞态：旧实例 dispose 未收尾时新实例会撞 mcp-client 的命名保留（already in use）——同名重建现在串行等待
- 每台服务器可配置 `toolCallTimeoutMs` / `failOnStartupError`（schema、校验、配置构造、指纹、表单均支持）
- 密钥不入盘：env / headers 值支持 `env:NAME` / `cred:NAME` 引用，挂载时解析（进程环境变量 / DSH credentials），未配置时保留字面值并告警
- `settings/updated` 去抖合并（同一 tick 多次变更只跑一次 sync），挂载串行化
- 客户端导航图标覆盖自检：设置页渲染时验证选择器是否命中，外壳类名哈希变化时打警告（功能不受影响）

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
