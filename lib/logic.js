// dsh-mcp-manager — pure host-side logic.
//
// 与 Cordis 运行时无关的纯逻辑（settings namespace schema、HTTP 校验、
// mcp-client 实例配置构造、配置指纹、mcp-client 日志→状态翻译、密钥引用
// 替换），单独成模块以便用 node:test 直接单测，也是「兼容性测试」的锚点：
// lib 产出的配置必须始终能被 @deepseek-ai/dsh-mcp-client 的 Config schema
// 接受（见 test/contract.test.js）。
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
  toolCallTimeoutMs: Schema.number().min(1).default(60000),
  failOnStartupError: Schema.boolean().default(false),
});

export const ServersSchema = Schema.object({
  servers: Schema.array(ServerSchema).default([]),
});

// 把设置页的一台服务器配置翻译成 mcp-client 实例配置。只输出契约内的键；
// enabled 由调用方（mountOne）处理，不进入实例配置。
// toolCallTimeoutMs / failOnStartupError 是 0.2.1 起每个服务器可配置的项，
// 缺省时回落到 mcp-client 契约默认值（60000 / false）。
export function buildClientConfig(server) {
  const config = {
    serverName: server.serverName,
    transport: server.transport,
    toolCallTimeoutMs: Number.isFinite(server.toolCallTimeoutMs) && server.toolCallTimeoutMs >= 1
      ? server.toolCallTimeoutMs
      : 60000,
    failOnStartupError: server.failOnStartupError === true,
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
    if (server.toolCallTimeoutMs !== undefined && server.toolCallTimeoutMs !== null
      && (!Number.isFinite(server.toolCallTimeoutMs) || server.toolCallTimeoutMs < 1)) {
      return `toolCallTimeoutMs 必须是 >= 1 的数字（毫秒）：${JSON.stringify(server.toolCallTimeoutMs)}`;
    }
    if (server.failOnStartupError !== undefined && server.failOnStartupError !== null
      && typeof server.failOnStartupError !== 'boolean') {
      return `failOnStartupError 必须是布尔值：${JSON.stringify(server.failOnStartupError)}`;
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

// 配置指纹：字段都列出来，忽略键顺序外的噪声；enabled 与新增的可配置项
// 参与比较，这样开关切换/超时变更会被识别为「配置变化」。
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
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: server.failOnStartupError,
  });
}

// ── mcp-client 日志 → 挂载状态 ──────────────────────────────────────────
//
// mcp-client 的异步失败/恢复只出现在它的日志里（`mcp-client(<serverName>):`，
// 经 Cordis logger exporter 截获，message = { name, type, args }）。这里把
// 日志文本翻译成 mountState 转换，解析规则与 mcp-client 0.1.x 的日志文案
// 绑定（test/host-logic.test.js 用真实文案做夹具）。返回 null 表示无关。

export function mcpClientLogToStatus(message) {
  if (!message || typeof message !== 'object') return null;
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith('mcp-client')) return null;
  const text = typeof message.args?.[0] === 'string' ? message.args[0] : '';
  const match = /^mcp-client\(([^)]+)\): ([\s\S]*)$/.exec(text);
  if (!match) return null;
  const serverName = match[1];
  const content = match[2].trim();

  const after = (prefix) => content.slice(prefix.length).replace(/^:\s*/, '').trim();
  let result = null;

  if (content.startsWith('connection attempt failed:')) {
    result = { state: 'error', message: `连接失败：${after('connection attempt failed:')}` };
  } else if (content.startsWith('connection failed; retrying')) {
    result = { state: 'error', message: '连接失败，重试中…' };
  } else if (content.startsWith('connection lost; reconnecting')) {
    result = { state: 'error', message: '连接中断，重连中…' };
  } else if (content.startsWith('reconnected and re-synced tools')) {
    result = { state: 'ok', message: '' };
  } else if (content.startsWith('giving up after')) {
    result = { state: 'error', message: '连续重连失败已放弃：需重载插件或重启 Host 才能恢复' };
  } else if (content.includes('connection failed and reconnect is disabled')) {
    result = { state: 'error', message: '连接失败（重连已关闭）：需重载插件或重启 Host' };
  } else if (content.includes('connection lost and reconnect is disabled')) {
    result = { state: 'error', message: '连接中断（重连已关闭）：已注册工具将失效' };
  } else if (content.startsWith('tool registration failed, no tools registered')) {
    result = { state: 'error', message: `工具注册失败：${after('tool registration failed, no tools registered') || '(无详情)'}` };
  } else if (content.startsWith('tool re-sync failed:')) {
    result = { state: 'error', message: `工具列表重新同步失败：${after('tool re-sync failed:')}` };
  } else if (content.startsWith('failed generation did not close within')) {
    result = { state: 'error', message: '连接关闭超时，已停止重连：需重载插件或重启 Host' };
  } else {
    return null;
  }
  return { serverName, state: result.state, message: result.message };
}

// ── 密钥引用 ────────────────────────────────────────────────────────────
//
// env / headers 的「值」可以写成引用，避免密钥明文落盘 settings.yaml：
//   env:NAME  → 进程环境变量 process.env.NAME
//   cred:NAME → DSH 凭据（ctx.credentials.resolve(NAME)，需运行方注入）
// 引用在挂载时解析（不入持久化层），解析失败保留字面值并由调用方告警。

export const SECRET_REF_PATTERN = /^(env|cred):([A-Za-z_][A-Za-z0-9_]*)$/;

// resolveOne(name, kind) 返回 Promise<string | undefined>（同步值会被 await）。
// 返回新的配置对象，不改动入参。
export async function substituteSecretRefs(config, resolveOne) {
  const substitute = async (value) => {
    if (typeof value !== 'string') return value;
    const match = SECRET_REF_PATTERN.exec(value);
    if (!match) return value;
    const resolved = await resolveOne(match[2], match[1]);
    return resolved === undefined ? value : resolved;
  };
  const next = { ...config };
  if (config.env && typeof config.env === 'object') {
    const env = {};
    for (const [key, value] of Object.entries(config.env)) env[key] = await substitute(value);
    next.env = env;
  }
  if (config.headers && typeof config.headers === 'object') {
    const headers = {};
    for (const [key, value] of Object.entries(config.headers)) headers[key] = await substitute(value);
    next.headers = headers;
  }
  return next;
}