// dsh-mcp-manager — host half.
//
// MCP 服务器管理器：把 MCP 服务器配置放进 settings 命名空间 `mcp`
// （持久化到 settings.yaml），并按配置在宿主侧挂载/卸载
// @deepseek-ai/dsh-mcp-client 实例；每个服务器带 `enabled` 开关
// （默认 true）：开启/关闭只重建对应实例，其余不受影响；同时注册
// 一个纯 JSON 的 HTTP 接口供设置页读写：
//
//   GET  /api/mcp/servers   -> { servers: [...], status: {...} }
//   POST /api/mcp/servers   <- { servers: [...] }   （整体替换，返回错误时 400）
//
// 生命周期：settings.register 的命名空间与 webServer.register 的路由
// 都是本插件 fiber 的 effect，插件被移除时自动清理；每个 mcp-client
// 实例通过 ctx.plugin() 挂载并持有 disposer，配置变化时按差异重建
// （dsh-mcp-client 自身处理断开重连与工具注册/注销）。

import Schema from '@deepseek-ai/schemastery';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';

export const name = 'dsh-mcp-manager';
export const inject = ['settings'];

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_BODY_BYTES = 1024 * 1024;

// settings 命名空间 `mcp` 的 schema。settings 的每个命名空间必须是
// 「键组成的对象」，所以服务器列表包在 `servers` 键下；字段全部带默认值，
// transport 相关的必填性（stdio 要 command / http 要 url）在 HTTP 接口里做
// 明确校验。
const ServerSchema = Schema.object({
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

const ServersSchema = Schema.object({
  servers: Schema.array(ServerSchema).default([]),
});

function buildClientConfig(server) {
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

function validateServers(servers) {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx) {
  const scope = ctx.settings.register('mcp', ServersSchema);

  // serverName -> ctx.plugin() 的 ForkHandle
  const handles = new Map();
  // serverName -> 已挂载实例的配置指纹（用于跳过未变化的服务器）
  const handleKeys = new Map();
  // serverName -> { state: 'ok' | 'error' | 'disabled', message: string }
  const mountState = new Map();

  // 配置指纹：字段都列出来，忽略键顺序外的噪声；enabled 参与比较，
  // 这样开关切换会被识别为「配置变化」。
  const serverKey = (server) => JSON.stringify({
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

  const unmountOne = (serverName) => {
    const handle = handles.get(serverName);
    if (handle) {
      try { handle.dispose(); } catch (error) { /* already disposed */ }
      handles.delete(serverName);
    }
    handleKeys.delete(serverName);
    mountState.delete(serverName);
  };

  const mountOne = (server) => {
    unmountOne(server.serverName);
    if (server.enabled === false) {
      mountState.set(server.serverName, { state: 'disabled', message: '' });
      return;
    }
    try {
      const handle = ctx.plugin({
        name: 'mcp-client',
        inject: ['tools'],
        apply: McpClient.apply,
      }, buildClientConfig(server));
      handles.set(server.serverName, handle);
      handleKeys.set(server.serverName, serverKey(server));
      mountState.set(server.serverName, { state: 'ok', message: '' });
    } catch (error) {
      mountState.set(server.serverName, {
        state: 'error',
        message: String((error && error.message) || error),
      });
    }
  };

  // 把内存实例与最新配置对齐：新增/变更的服务器重建，被移除的卸载，
  // 未变化的保持不动——开启/关闭某台服务器只影响它自己。
  const sync = (servers) => {
    const seen = new Set();
    for (const server of servers) {
      seen.add(server.serverName);
      const mounted = handles.has(server.serverName);
      if (mounted && handleKeys.get(server.serverName) === serverKey(server)) continue;
      mountOne(server);
    }
    for (const serverName of Array.from(new Set([...handles.keys(), ...mountState.keys()]))) {
      if (!seen.has(serverName)) unmountOne(serverName);
    }
  };

  // settings/updated 是提交后的事件：配置一变，按差异对齐实例。
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== 'mcp') return;
    sync(next && Array.isArray(next.servers) ? next.servers : []);
  });

  // 启动时按当前配置挂载（enabled: false 的服务器只记录为已关闭）。
  const current = ctx.settings.get('mcp');
  sync(current && Array.isArray(current.servers) ? current.servers : []);

  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/mcp/servers',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const value = ctx.settings.get('mcp');
            const servers = value && Array.isArray(value.servers) ? value.servers : [];
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ servers, status: Object.fromEntries(mountState) }));
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
              return;
            }
            const invalid = validateServers(parsed.servers);
            if (invalid !== null) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: invalid }));
              return;
            }
            await ctx.settings.replace('mcp', { servers: parsed.servers });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String((error && error.message) || error) }));
        }
      },
    }), 'dsh-mcp-manager: http api');
  }
}
