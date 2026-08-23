# Changelog

## 0.2.1

- 作者邮箱更新为 fishlijewater@126.com，package.json 增加 `engines.node >= 18`
- 新增兼容性测试套件（`npm test`，node:test 零依赖）：宿主纯逻辑单测、客户端 bundle vm 沙箱测试、以及用真实 `@deepseek-ai/dsh-mcp-client` Config schema 校验配置产出的契约测试
- 新增 CI（GitHub Actions）：Node 18/20/22 × dsh-mcp-client 0.1.0-rc.6 / 0.1.0-rc.8 / 0.1.1-rc.2 版本矩阵
- 纯逻辑抽到 `lib/logic.js`（settings schema、校验、配置构造、配置指纹），`client.js` 导出解析/组装助手供测试复用，行为不变

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
