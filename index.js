// dsh-mcp-manager — host half.
//
// MCP 服务器管理器：把 MCP 服务器配置放进 settings 命名空间 `mcp`
// （持久化到 settings.yaml），并按配置在宿主侧挂载/卸载
// @deepseek-ai/dsh-mcp-client 实例；同时注册一个纯 JSON 的 HTTP 接口
// 供设置页读写：
//
//   GET  /api/mcp/servers   -> { servers: [...], status: {...} }
//   POST /api/mcp/servers   <- { servers: [...] }   （整体替换，返回错误时 400）
//
// 生命周期：settings.register 的命名空间与 webServer.register 的路由
// 都是本插件 fiber 的 effect，插件被移除时自动清理；每个 mcp-client
// 实例通过 ctx.plugin() 挂载并持有 disposer，配置变化时全部重建
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
  // serverName -> { state: 'ok' | 'error', message: string }
  const mountState = new Map();

  const disposeAll = () => {
    for (const handle of handles.values()) {
      try { handle.dispose(); } catch (error) { /* already disposed */ }
    }
    handles.clear();
  };

  const mountAll = (servers) => {
    disposeAll();
    mountState.clear();
    for (const server of servers) {
      try {
        const handle = ctx.plugin({
          name: 'mcp-client',
          inject: ['tools'],
          apply: McpClient.apply,
        }, buildClientConfig(server));
        handles.set(server.serverName, handle);
        mountState.set(server.serverName, { state: 'ok', message: '' });
      } catch (error) {
        mountState.set(server.serverName, {
          state: 'error',
          message: String((error && error.message) || error),
        });
      }
    }
  };

  // settings/updated 是提交后的事件：配置一变，重建全部实例。
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== 'mcp') return;
    mountAll(next && Array.isArray(next.servers) ? next.servers : []);
  });

  // 启动时按当前配置挂载一次。
  const current = ctx.settings.get('mcp');
  mountAll(current && Array.isArray(current.servers) ? current.servers : []);

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
