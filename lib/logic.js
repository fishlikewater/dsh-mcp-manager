// dsh-mcp-manager — pure host-side logic.
//
// 与 Cordis 运行时无关的纯逻辑（settings namespace schema、HTTP 校验、
// mcp-client 实例配置构造、配置指纹），单独成模块以便用 node:test 直接
// 单测，也是「兼容性测试」的锚点：lib 产出的配置必须始终能被
// @deepseek-ai/dsh-mcp-client 的 Config schema 接受（见 test/contract.test.js）。
//
// mcp-client 配置契约（0.1.0-rc.6 ~ 0.1.1-rc.2 一致，DSH 随带 ^0.1.1-rc.1）：
//
//   stdio:           { transport: 'stdio', serverName, command,
//                      args: string[] = [], env: dict = {}, cwd = '',
//                      toolCallTimeoutMs = 60000, failOnStartupError = false }
//   streamable-http: { transport: 'streamable-http', serverName, url,
//                      headers: dict = {}, toolCallTimeoutMs = 60000,
//                      failOnStartupError = false }
//
// 多余的键 schemastery 不会拒绝、也不会剥离（会原样保留），所以
// buildClientConfig 仍必须只输出契约内的键，避免多余字段被当配置传入
// mcp-client（test/host-logic.test.js 逐键断言 key 集合）。

import Schema from '@deepseek-ai/schemastery';

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// settings 命名空间 `mcp` 的 schema。settings 的每个命名空间必须是
// 「键组成的对象」，所以服务器列表包在 `servers` 键下；字段全部带默认值，
// transport 相关的必填性（stdio 要 command / http 要 url）在 HTTP 接口里做
// 明确校验。
export const ServerSchema = Schema.object({
  serverName: Schema.string().pattern(SERVER_NAME_PATTERN),
  enabled: Schema.boolean().default(true),
  transport: Schema.union(['stdio', 'streamable-http']),
  command: Schema.string().default(''),
  args: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  cwd: Schema.string().default(''),
  url: Schema.string().default(''),
  headers: Schema.dict(Schema.string()).default({}),
});

export const ServersSchema = Schema.object({
  servers: Schema.array(ServerSchema).default([]),
});

// 把设置页的一台服务器配置翻译成 mcp-client 实例配置。只输出契约内的键；
// enabled 由调用方（mountOne）处理，不进入实例配置。
export function buildClientConfig(server) {
  const config = {
    serverName: server.serverName,
    transport: server.transport,
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
  };
  if (server.transport === 'stdio') {
    config.command = server.command;
    config.args = Array.isArray(server.args) ? server.args : [];
    config.env = server.env && typeof server.env === 'object' ? server.env : {};
    if (server.cwd) config.cwd = server.cwd;
  } else {
    config.url = server.url;
    config.headers = server.headers && typeof server.headers === 'object' ? server.headers : {};
  }
  return config;
}

// HTTP 接口的明确校验（settings schema 的默认值会掩盖缺失字段，所以这里
// 单独做必填与重复检查）。返回错误文案，合法时返回 null。
export function validateServers(servers) {
  if (!Array.isArray(servers)) return 'servers 必须是数组';
  const seen = new Set();
  for (const server of servers) {
    if (!server || typeof server !== 'object') return '每个服务器必须是一个对象';
    if (typeof server.serverName !== 'string' || !SERVER_NAME_PATTERN.test(server.serverName)) {
      return `serverName 无效：应为 1-32 位字母数字下划线连字符，收到 ${JSON.stringify(server.serverName)}`;
    }
    if (seen.has(server.serverName)) return `serverName 重复：${server.serverName}`;
    seen.add(server.serverName);
    if (server.enabled !== undefined && server.enabled !== null && typeof server.enabled !== 'boolean') {
      return `enabled 必须是布尔值：${JSON.stringify(server.enabled)}`;
    }
    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || server.command.trim() === '') {
        return `stdio 服务器 ${server.serverName} 必须提供 command`;
      }
    } else if (server.transport === 'streamable-http') {
      if (typeof server.url !== 'string' || server.url.trim() === '') {
        return `streamable-http 服务器 ${server.serverName} 必须提供 url`;
      }
    } else {
      return `transport 无效：${JSON.stringify(server.transport)}（应为 stdio 或 streamable-http）`;
    }
  }
  return null;
}

// 配置指纹：字段都列出来，忽略键顺序外的噪声；enabled 参与比较，
// 这样开关切换会被识别为「配置变化」。
export function serverKey(server) {
  return JSON.stringify({
    serverName: server.serverName,
    enabled: server.enabled !== false,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
  });
}