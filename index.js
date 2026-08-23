// dsh-mcp-manager — host half.
//
// MCP 服务器管理器：把 MCP 服务器配置放进 settings 命名空间 `mcp`
// （持久化到 settings.yaml），并按配置在宿主侧挂载/卸载
// @deepseek-ai/dsh-mcp-client 实例；每个服务器带 `enabled` 开关
// （默认 true）：开启/关闭只重建对应实例，其余不受影响；同时注册
// 一个纯 JSON 的 HTTP 接口供设置页读写：
//
//   GET  /api/mcp/servers   -> { rev, servers: [...], status: {...} }
//   POST /api/mcp/servers   <- { rev?, servers: [...] }
//                            （rev 是乐观锁：不匹配当前修订时返回 409）
//
// 生命周期：settings.register 的命名空间与 webServer.register 的路由
// 都是本插件 fiber 的 effect，插件被移除时自动清理；每个 mcp-client
// 实例通过 ctx.plugin() 挂载并持有 disposer，配置变化时按差异重建
// （dsh-mcp-client 自身处理断开重连与工具注册/注销）。
//
// 状态的真实性：mcp-client 的连接/工具注册失败是异步的，只出现在它的
// 日志里；本插件通过 Cordis logger exporter 截获 mcp-client 日志并翻译
// 成 mountState（状态转换规则见 lib/logic.js 的 mcpClientLogToStatus）。
//
// 密钥不入盘：env / headers 的值支持 `env:NAME` 与 `cred:NAME` 引用，
// 挂载时解析（进程环境变量 / ctx.credentials），settings.yaml 只存引用。

import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import {
  ServersSchema,
  buildClientConfig,
  serverKey,
  validateServers,
  mcpClientLogToStatus,
  substituteSecretRefs,
} from './lib/logic.js';

export const name = 'dsh-mcp-manager';
export const inject = ['settings'];

const MAX_BODY_BYTES = 1024 * 1024;

// settings 命名空间 `mcp` 的 schema 与实例配置/校验纯逻辑见 ./lib/logic.js。

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
  ctx.settings.register('mcp', ServersSchema);

  // serverName -> ctx.plugin() 的 Fiber
  const handles = new Map();
  // serverName -> 已挂载实例的配置指纹（用于跳过未变化的服务器）
  const handleKeys = new Map();
  // serverName -> { state: 'ok' | 'error' | 'disabled', message: string }
  const mountState = new Map();

  // 挂载串行链 + 去抖：同一 tick 多次 settings/updated 合并成一次 sync。
  let syncChain = Promise.resolve();
  let pendingServers = null;
  let syncScheduled = false;

  // 读取 mcp 命名空间的当前修订号（并发保存的乐观锁依据）。
  const currentRev = () => {
    if (typeof ctx.settings.describe !== 'function') return 0;
    const descriptor = ctx.settings.describe().find((entry) => entry && entry.ns === 'mcp');
    return descriptor ? descriptor.revision : 0;
  };

  const disposeHandle = async (serverName) => {
    const handle = handles.get(serverName);
    handles.delete(serverName);
    handleKeys.delete(serverName);
    if (handle) {
      // 必须等旧实例 dispose 完成：mcp-client 把 serverName 做成「活跃命名
      // 保留」（activeServerNames），快速卸载/重挂同一名字时若不等它的
      // 异步收尾，新实例会报 already in use。
      try { await handle.dispose(); } catch (error) { /* already disposed */ }
    }
  };

  const unmountOne = async (serverName) => {
    await disposeHandle(serverName);
    mountState.delete(serverName);
  };

  // `env:NAME` → 进程环境变量；`cred:NAME` → DSH 凭据。解析失败保留字面值。
  const secretResolver = async (name, kind) => {
    if (kind === 'env') {
      const value = process.env[name];
      if (value === undefined) {
        ctx.logger.warn(`dsh-mcp-manager: 环境变量 "${name}" 未设置，env 引用保留字面值`);
      }
      return value;
    }
    const credentials = ctx.get('credentials');
    if (credentials === undefined) {
      ctx.logger.warn(`dsh-mcp-manager: credentials 服务不可用，cred 引用 "${name}" 保留字面值`);
      return undefined;
    }
    const resolved = await credentials.resolve(name);
    if (resolved === undefined) {
      ctx.logger.warn(`dsh-mcp-manager: 凭据 "${name}" 未配置，cred 引用保留字面值`);
      return undefined;
    }
    return resolved.value;
  };

  const mountOne = async (server) => {
    if (server.enabled === false) {
      // 立即呈现 disabled 状态（UI 即时反馈），实例收尾在后台完成。
      mountState.set(server.serverName, { state: 'disabled', message: '' });
      await disposeHandle(server.serverName);
      return;
    }
    // 串行化：先等该服务器的旧实例完全收尾（dispose）再建新实例。
    await unmountOne(server.serverName);
    try {
      const config = await substituteSecretRefs(buildClientConfig(server), secretResolver);
      const handle = ctx.plugin({
        name: 'mcp-client',
        inject: ['tools'],
        apply: (childCtx, config) => McpClient.apply(childCtx, config).catch((error) => {
          // failOnStartupError: true 时 apply 会因首次连接/工具同步失败而
          // 抛错。这里吞掉：连接 supervisor 仍在后台重连，错误细节已经由
          // 日志跟踪（logger exporter）呈现到挂载状态。避免未处理的
          // rejection 打到 Cordis fiber 上。
          ctx.logger.warn(`dsh-mcp-manager: mcp-client(${server.serverName}) 启动失败：${String((error && error.message) || error)}（实例保持存活以继续重连）`);
        }),
      }, config);
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
  // 未变化的保持不动——开启/关闭某台服务器只影响它自己。不同名字的
  // 操作并行，同一名字由 unmountOne 的 await 保证串行。
  const sync = async (servers) => {
    const seen = new Set();
    const jobs = [];
    for (const server of servers) {
      seen.add(server.serverName);
      const mounted = handles.has(server.serverName);
      if (mounted && handleKeys.get(server.serverName) === serverKey(server)) continue;
      jobs.push(mountOne(server));
    }
    for (const serverName of Array.from(new Set([...handles.keys(), ...mountState.keys()]))) {
      if (!seen.has(serverName)) jobs.push(unmountOne(serverName));
    }
    await Promise.all(jobs);
  };

  const scheduleSync = (servers) => {
    pendingServers = servers || [];
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      const list = pendingServers;
      pendingServers = null;
      syncChain = syncChain.then(() => sync(list)).catch((error) => {
        ctx.logger.warn(`dsh-mcp-manager: 同步挂载失败：${String((error && error.message) || error)}`);
      });
    });
  };

  // 日志驱动的真实挂载状态：mcp-client 的异步失败/恢复只出现在它的日志里
  // （失败多为 warn 级）。exporter 默认只转发 <= info 级别的消息，这里显式
  // 声明 levels.default = 3 接收全部级别。exporter 随本插件 fiber 一起释放；
  // 只更新仍在管理中的服务器。
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      const update = mcpClientLogToStatus(message);
      if (!update || !mountState.has(update.serverName)) return;
      mountState.set(update.serverName, { state: update.state, message: update.message });
    },
  });

  // settings/updated 是提交后的事件：配置一变，按差异对齐实例（去抖合并）。
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== 'mcp') return;
    scheduleSync(next && Array.isArray(next.servers) ? next.servers : []);
  });

  // 启动时按当前配置挂载（enabled: false 的服务器只记录为已关闭）。
  const current = ctx.settings.get('mcp');
  scheduleSync(current && Array.isArray(current.servers) ? current.servers : []);

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
            res.end(JSON.stringify({ rev: currentRev(), servers, status: Object.fromEntries(mountState) }));
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
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: '请求体必须是 { servers: [...] }' }));
              return;
            }
            const { rev } = parsed;
            if (rev !== undefined && rev !== null && (!Number.isInteger(rev) || rev < 0)) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: `rev 必须是 >= 0 的整数，收到 ${JSON.stringify(rev)}` }));
              return;
            }
            const invalid = validateServers(parsed.servers);
            if (invalid !== null) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: invalid }));
              return;
            }
            try {
              await ctx.settings.replace('mcp', { servers: parsed.servers }, rev === undefined ? undefined : rev);
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: true }));
            } catch (error) {
              if (error && error.code === 'SETTINGS_CONFLICT') {
                res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                  error: '配置已被其他窗口/页面修改，请刷新后重试',
                  code: 'conflict',
                  rev: currentRev(),
                }));
                return;
              }
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: String((error && error.message) || error) }));
            }
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