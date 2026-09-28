// dsh-mcp-manager — host half（0.3.0，面向 DSH 0.1.7-rc.2 及以后的 Web/桌面组合）。
//
// 配置模型：本插件声明自己的 `Config`（schemastery schema），servers 列表就是
// 本 Loader 条目（patch 里的 `id: mcp-manager`）的 config。
//
// `servers` 必须是 volatile 字段，这是「设置页能列出本插件」的硬前提：settings
// 服务只把「schema 里带 volatile 字段」的活跃条目投影成配置命名空间（app.asar
// 919014：volatileForm(schema) 为 undefined 时直接 return []，整个条目被跳过），
// 并且只接受路径落在 volatile 子树内的写入（isVolatilePath）。
//
// 代价是 volatile 变更**不重载本条目**：Loader 把新值提交进运行中的引用后 emit
// `loader/volatile-update`，apply 不会重跑 —— 所以下面监听该事件，自己卸载再按
// 新值挂载 @deepseek-ai/dsh-mcp-client 实例。
//
// volatile 字段解析后是 cosmokit 的 Volatile<T> 稳定引用，取值必须走 .get()
// （读值统一由 volatileValue() 处理）。
//
// 为什么不再用 `ctx.settings.register('mcp', …)` + 自建 HTTP 路由：
//   1. 0.1.7 起 `$DSH_HOME/settings.yaml` 已废弃，用户设置统一落在「Loader 条目
//      的 config」里（loopback/桌面端持久化到 `$DSH_HOME/cordis.patch.yml`），
//      设置命名空间的约定就是条目 id（无条目时用插件名）。
//   2. 客户端可读写的命名空间由宿主 api-proxy 的白名单门控，插件自注册的额外
//      命名空间不保证被 serve 给浏览器；条目的 config 才走官方 `settings`
//      remote（客户端 `connection.api.settings.describe/mutate`）。
//   3. 桌面端同样通过 Web application 启动 Desktop profile，但设置通道走
//      官方 settings remote 比自建 HTTP 路由更稳（不依赖路由注册时机）。
//
// 每个服务器：
//   - `enabled: false` → 跳过挂载（配置保留，随时可开）；
//   - 其余字段校验通过后挂载一个 mcp-client 实例，工具名 `mcp__<名称>__<工具名>`；
//   - 实例的 disposed 生命周期绑定本插件的 fiber：条目重载/移除时自动卸载。
//
// mcp-client 的取用方式见下方 loadMcpClient：优先裸导入（由 profile 的 runtime
// 解析拦截路由到宿主自带的那一份），拦截缺失时用 ctx.pluginPackages 定位包目录
// 再按绝对路径导入 —— 两条路都拿宿主那一份，不会产生重复实例。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-mcp-manager';

// 本插件不使用任何其他服务：挂载 mcp-client 所需的服务由 mcp-client 自己 inject。
export const inject = [];

const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

// 服务器条目 schema。所有字段都带默认值，让「坏配置」只影响它自己那一台，
// 而不是让整个条目的 config 校验失败（必填性在 apply 里逐台校验并记日志）。
const ServerSchema = Schema.object({
  serverName: Schema.string().default(''),
  enabled: Schema.boolean().default(true),
  transport: Schema.union(['stdio', 'streamable-http']).default('stdio'),
  command: Schema.string().default(''),
  // args / env / headers 的值放宽为 any：用户在设置页里很容易写成数字
  // （例如 PORT: 8080）或布尔，严格的 string 校验会让整个条目的 config 校验失败，
  // 连带所有服务器一起不挂载 —— 一个值写错不该毁掉整份配置。
  // 字符串化统一在 buildClientConfig 里做。
  args: Schema.array(Schema.any()).default([]),
  env: Schema.dict(Schema.any()).default({}),
  cwd: Schema.string().default(''),
  url: Schema.string().default(''),
  headers: Schema.dict(Schema.any()).default({}),
});

export const Config = Schema.object({
  // servers 标为 volatile。volatile 只能落在固定对象路径上且不能嵌套：如果改成在
  // ServerSchema 内部标 volatile，schemastery 的 validateVolatileSchema 会以
  // 「volatile fields require a fixed object path」拒绝整份配置。
  // 只有 volatile 字段会出现在设置页表单里，也只有 volatile 子树内的路径可写。
  servers: Schema.array(ServerSchema).default([]).volatile(),
  toolCallTimeoutMs: Schema.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
});

/** volatile 字段解析后是 Volatile<T> 稳定引用，取值走 .get()；裸值原样返回。 */
function volatileValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** servers 必须是数组，其它输入一律当空表。 */
function toServerArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/** 把任意标量转成字符串；对象退化为 JSON，null / undefined 退化为空串。 */
function scalar(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** env / headers：值统一字符串化；非对象输入退化为空表。 */
function stringDict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) out[key] = scalar(value[key]);
  return out;
}

function message(error) {
  return String((error && error.message) || error);
}

/** transport 缺省视为 stdio：条目 config 未经 schema 填充时也能正确工作。 */
function normalizeTransport(server) {
  const transport = text(server.transport).trim();
  return transport === '' ? 'stdio' : transport;
}

/** 返回第一条错误说明，全部通过时返回 null。 */
function validateServer(server) {
  const serverName = text(server.serverName).trim();
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    return `serverName 无效：应为 1-32 位字母数字下划线连字符，收到 ${JSON.stringify(server.serverName)}`;
  }
  const transport = normalizeTransport(server);
  if (transport === 'stdio') {
    if (text(server.command).trim() === '') return 'stdio 传输必须提供 command';
    return null;
  }
  if (server.transport === 'streamable-http') {
    if (text(server.url).trim() === '') return 'streamable-http 传输必须提供 url';
    return null;
  }
  return `transport 无效：${JSON.stringify(server.transport)}（应为 stdio 或 streamable-http）`;
}

/** 把管理器条目里的一条配置翻译成 mcp-client 的实例配置。 */
function buildClientConfig(server, toolCallTimeoutMs) {
  const transport = normalizeTransport(server);
  const config = {
    serverName: text(server.serverName).trim(),
    transport,
    toolCallTimeoutMs: Number.isFinite(toolCallTimeoutMs) ? toolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  };
  if (transport === 'stdio') {
    config.command = text(server.command);
    config.args = Array.isArray(server.args)
      ? server.args.filter((arg) => arg !== null && arg !== undefined).map(scalar)
      : [];
    config.env = stringDict(server.env);
    const cwd = text(server.cwd).trim();
    if (cwd !== '') config.cwd = cwd;
  } else {
    config.url = text(server.url).trim();
    config.headers = stringDict(server.headers);
  }
  return config;
}

/** 从包的 manifest 里挑出入口文件（exports "." → main → index.js）。 */
function entryOf(manifest) {
  const exportsField = manifest && manifest.exports;
  let candidate;
  if (typeof exportsField === 'string') {
    candidate = exportsField;
  } else if (exportsField && typeof exportsField === 'object') {
    const dot = exportsField['.'];
    if (typeof dot === 'string') candidate = dot;
    else if (dot && typeof dot === 'object') candidate = dot.import || dot.node || dot.default || dot.require;
  }
  if (typeof candidate !== 'string' || candidate === '') candidate = (manifest && manifest.main) || 'index.js';
  return String(candidate).replace(/^\.\//, '');
}

/** 用宿主的 profile 包解析服务定位一个包，拿不到就返回 undefined。 */
function locatePackage(ctx, specifier) {
  let service;
  try {
    service = typeof ctx.get === 'function' ? ctx.get('pluginPackages') : undefined;
  } catch {
    service = undefined;
  }
  if (service === undefined || service === null) service = ctx.pluginPackages;
  if (service === undefined || service === null || typeof service.packageOf !== 'function') return undefined;
  try {
    return service.packageOf(specifier, import.meta.url);
  } catch {
    return undefined;
  }
}

let mcpClientModule;

/**
 * 取 mcp-client 模块命名空间（进程内只解析一次，避免两份实例互相抢占 serverName）。
 *
 * 1. 裸导入：桌面版/CLI 都会在 profile 进程里安装 runtime 解析拦截，把 profile 内
 *    插件的裸导入路由到运行时自带的那份包（因此不需要在 profile 里再装一份）。
 * 2. 回退：拦截不可用时，用 ctx.pluginPackages 走同一条 runtime 解析拿到包目录，
 *    再按绝对路径导入 —— 仍是宿主那一份。
 */
async function loadMcpClient(ctx) {
  if (mcpClientModule !== undefined) return mcpClientModule;
  let primaryError;
  try {
    mcpClientModule = await import(MCP_CLIENT_PACKAGE);
    return mcpClientModule;
  } catch (error) {
    primaryError = error;
  }
  const info = locatePackage(ctx, MCP_CLIENT_PACKAGE);
  const dir = info && typeof info.dir === 'string' ? info.dir : undefined;
  if (dir === undefined) throw primaryError;
  mcpClientModule = await import(pathToFileURL(join(dir, entryOf(info.manifest))).href);
  return mcpClientModule;
}

/** 从模块命名空间里取插件主体（兼容 ESM / CJS 互操作）。 */
function pluginBody(module) {
  if (module === null || module === undefined) return undefined;
  if (typeof module.apply === 'function') return module;
  const fallback = module.default;
  if (fallback && typeof fallback.apply === 'function') return fallback;
  return undefined;
}

export async function apply(ctx, config) {
  const settings = config || {};
  const warn = (line) => {
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(line);
  };
  const info = (line) => {
    if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(line);
  };

  // 已挂载的 mcp-client 实例（fiber）。volatile 变更不会重载本条目，需要自己卸载再挂载。
  let mountings = [];

  /** 卸载本插件挂上去的全部 mcp-client 实例。 */
  const unmountAll = () => {
    const stale = mountings;
    mountings = [];
    for (const fiber of stale) {
      try {
        if (fiber && typeof fiber.dispose === 'function') fiber.dispose();
      } catch (error) {
        warn(`[dsh-mcp-manager] 卸载 mcp-client 实例失败 — ${message(error)}`);
      }
    }
    return stale.length;
  };

  /** 按当前（volatile）配置校验、筛选并挂载全部服务器。 */
  const mountAll = async () => {
    const servers = toServerArray(volatileValue(settings.servers));
    const toolCallTimeoutMs = volatileValue(settings.toolCallTimeoutMs);

    // 先只做校验与筛选：没有要挂载的服务器时完全不碰 mcp-client，空配置也不会报错。
    const pending = [];
    const seen = new Set();
    for (const server of servers) {
      const label = server && typeof server === 'object' ? text(server.serverName).trim() : '';
      const display = label === '' ? '<未命名>' : label;

      if (label === '') {
        warn(`[dsh-mcp-manager] 跳过一条没有 serverName 的配置`);
        continue;
      }
      if (seen.has(label)) {
        warn(`[dsh-mcp-manager] ${display}: serverName 重复，只挂载第一条`);
        continue;
      }
      seen.add(label);

      if (server.enabled === false) {
        info(`[dsh-mcp-manager] ${display}: 已关闭，跳过挂载`);
        continue;
      }

      const invalid = validateServer(server);
      if (invalid !== null) {
        warn(`[dsh-mcp-manager] ${display}: ${invalid}`);
        continue;
      }

      pending.push({ label, server });
    }

    if (pending.length === 0) {
      info(`[dsh-mcp-manager] 没有需要挂载的 MCP 服务器（共 ${servers.length} 条配置）`);
      return;
    }

    let mcpClient;
    try {
      mcpClient = pluginBody(await loadMcpClient(ctx));
    } catch (error) {
      warn(`[dsh-mcp-manager] 无法加载 ${MCP_CLIENT_PACKAGE}，${pending.length} 台服务器未挂载 — ${message(error)}`);
      return;
    }
    if (mcpClient === undefined) {
      warn(`[dsh-mcp-manager] ${MCP_CLIENT_PACKAGE} 没有导出 apply，${pending.length} 台服务器未挂载`);
      return;
    }

    let mounted = 0;
    for (const { label, server } of pending) {
      try {
        // fiber 生命周期由 cordis 持有：条目重载/移除时这些实例自动 dispose
        // （dsh-mcp-client 自己负责断开连接、注销工具、释放 serverName 占用）。
        // volatile 变更不会重载条目，由 unmountAll / mountAll 手动完成同样的事。
        const fiber = ctx.plugin({
          name: 'mcp-client',
          inject: ['tools'],
          apply: mcpClient.apply,
        }, buildClientConfig(server, toolCallTimeoutMs));
        mountings.push(fiber);
        mounted += 1;
        info(`[dsh-mcp-manager] ${label}: 已挂载（${normalizeTransport(server)}）`);
      } catch (error) {
        warn(`[dsh-mcp-manager] ${label}: 挂载失败 — ${message(error)}`);
      }
    }

    info(`[dsh-mcp-manager] 本轮挂载 ${mounted}/${pending.length} 台 MCP 服务器`);
  };

  await mountAll();

  // `servers` 是 volatile 字段：设置页保存后 Loader 只把新值提交进运行中的引用
  // （cosmokit 的 updateVolatile），不重载本条目，因此 apply 不会重跑。变更通过
  // `loader/volatile-update` 通知 owner fiber，这里据此卸载旧的再挂载新的。
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      void (async () => {
        unmountAll();
        // 让 mcp-client 的异步断开先落地，避免重挂载时 serverName 仍被占用。
        await new Promise((resolve) => setTimeout(resolve, 0));
        await mountAll();
      })().catch((error) => {
        warn(`[dsh-mcp-manager] 按新配置重新挂载失败 — ${message(error)}`);
      });
    });
  } else {
    warn('[dsh-mcp-manager] ctx.on 不可用，设置页的改动需要重启后才会生效');
  }
}
