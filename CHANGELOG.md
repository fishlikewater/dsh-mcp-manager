# Changelog

## 0.2.0

- 每台 MCP 服务器可单独开启/关闭：卡片上的开关按钮立即挂载/卸载对应实例，其余服务器不受影响
- 开关状态持久化在 `mcp.servers[].enabled`（默认 `true`），重启 dsh 后保持
- 挂载状态新增 `disabled`（已关闭）；实例按配置差异重建，未变化的服务器不再重连

## 0.1.0

- 首个版本：设置页「MCP 服务器」管理界面 + 宿主侧实例管理器
- settings 命名空间 `mcp.servers` 持久化，保存即热生效
- 支持 stdio 与 streamable-http 两种传输
- `dsh.bundle` 与 `dsh.client` 双 manifest，可通过 `dsh plugin add` 安装
