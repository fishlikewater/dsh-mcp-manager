// 宿主半自测：用假 ctx 驱动 apply，验证筛选、校验与挂载参数。
// 用法：node test/host.selftest.mjs
import { apply, Config } from '../index.js';
import { createRequire } from 'node:module';

// cosmokit 是 CJS 包，用 require 取它的 volatile 工具（取不到就跳过对应断言）。
let cosmokit;
try {
  cosmokit = createRequire(import.meta.url)('@deepseek-ai/cosmokit');
} catch {
  cosmokit = undefined;
}

let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${detail}`}`);
  }
}

function makeCtx() {
  const logs = [];
  const mounted = [];
  const handlers = new Map();
  let disposedCount = 0;
  const ctx = {
    logger: {
      warn: (line) => logs.push({ level: 'warn', line }),
      info: (line) => logs.push({ level: 'info', line }),
    },
    // 返回带 dispose 的假 fiber：volatile 变更时插件会 dispose 旧实例再重挂载。
    plugin: (plugin, config) => {
      const fiber = { plugin, config, dispose: () => { disposedCount += 1; } };
      mounted.push(fiber);
      return fiber;
    },
    on: (event, handler) => { handlers.set(event, handler); },
    get: () => undefined,
  };
  return { ctx, logs, mounted, handlers, disposedCount: () => disposedCount };
}

const warnText = (logs) => logs.filter((e) => e.level === 'warn').map((e) => e.line).join('\n');
const infoText = (logs) => logs.filter((e) => e.level === 'info').map((e) => e.line).join('\n');

console.log('[A] 空配置：不加载 mcp-client，也不报错');
{
  const { ctx, logs, mounted } = makeCtx();
  await apply(ctx, { servers: [] });
  check('没有 warn', warnText(logs) === '', warnText(logs));
  check('未挂载任何实例', mounted.length === 0);
  check('说明了 0 台', infoText(logs).includes('没有需要挂载'), infoText(logs));
}

console.log('[B] 非法 serverName 与缺 command 都被拦下');
{
  const { ctx, logs, mounted } = makeCtx();
  await apply(ctx, {
    servers: [
      { serverName: 'bad name', command: 'x' },
      { serverName: 'no-command' },
      { serverName: 'no-url', transport: 'streamable-http' },
      { serverName: 'ok-one', command: 'node' },
    ],
  });
  const warns = warnText(logs);
  check('serverName 无效被拦', warns.includes('serverName 无效'), warns);
  check('缺 command 被拦', warns.includes('stdio 传输必须提供 command'), warns);
  check('缺 url 被拦', warns.includes('streamable-http 传输必须提供 url'), warns);
  check('只剩合法的 1 台', mounted.length === 1, `mounted=${mounted.length}`);
}

console.log('[C] stdio 实例参数翻译正确');
{
  const { ctx, mounted } = makeCtx();
  await apply(ctx, {
    servers: [{
      serverName: 'demo',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--flag'],
      env: { A: '1' },
      cwd: 'E:/tmp',
    }],
    toolCallTimeoutMs: 1234,
  });
  check('挂载 1 个实例', mounted.length === 1);
  const c = mounted[0] && mounted[0].config;
  check('serverName 透传', c && c.serverName === 'demo', JSON.stringify(c));
  check('transport 透传', c && c.transport === 'stdio');
  check('timeout 透传', c && c.toolCallTimeoutMs === 1234);
  check('args 透传', c && Array.isArray(c.args) && c.args.length === 2);
  check('env 透传', c && c.env && c.env.A === '1');
  check('cwd 透传', c && c.cwd === 'E:/tmp');
  check('failOnStartupError 关闭', c && c.failOnStartupError === false);
  check('插件名是 mcp-client', mounted[0].plugin.name === 'mcp-client');
  check('注入 tools', Array.isArray(mounted[0].plugin.inject) && mounted[0].plugin.inject[0] === 'tools');
  check('带 apply 主体', typeof mounted[0].plugin.apply === 'function');
}

console.log('[D] streamable-http 实例参数翻译正确（且不带 command 字段）');
{
  const { ctx, mounted } = makeCtx();
  await apply(ctx, {
    servers: [{ serverName: 'remote', transport: 'streamable-http', url: 'http://127.0.0.1:5225/mcp', headers: { 'X-A': 'b' } }],
  });
  check('挂载 1 个实例', mounted.length === 1);
  const c = mounted[0] && mounted[0].config;
  check('url 透传', c && c.url === 'http://127.0.0.1:5225/mcp', JSON.stringify(c));
  check('headers 透传', c && c.headers && c.headers['X-A'] === 'b');
  check('没有 command 字段', c && c.command === undefined);
}

console.log('[E] 重复 serverName 只挂第一条；enabled:false 跳过');
{
  const { ctx, logs, mounted } = makeCtx();
  await apply(ctx, {
    servers: [
      { serverName: 'dup', command: 'node' },
      { serverName: 'dup', command: 'node' },
      { serverName: 'off', command: 'node', enabled: false },
    ],
  });
  check('重复名被警告', warnText(logs).includes('serverName 重复'), warnText(logs));
  check('关闭项被跳过', infoText(logs).includes('已关闭'), infoText(logs));
  check('只挂载 1 台', mounted.length === 1, `mounted=${mounted.length}`);
}

console.log('[F] 缺省 config（undefined）不崩');
{
  const { ctx, logs } = makeCtx();
  await apply(ctx, undefined);
  check('正常返回', infoText(logs).includes('没有需要挂载'), infoText(logs));
  check('没有 warn', warnText(logs) === '', warnText(logs));
}

console.log('[G] env / args / headers 的值容器放宽为 any 并统一字符串化');
{
  // 关键回归：以前 env 是 dict(string)，用户写 PORT: 8080 会让整个条目
  // config 校验失败 → 所有服务器一起不挂载。这里先过一遍真实 schema。
  let normalized;
  try {
    normalized = Config({
      servers: [{
        serverName: 'typed',
        transport: 'stdio',
        command: 'node',
        args: ['a', 2, true],
        env: { PORT: 8080, DEBUG: true, NAME: 'x', RATIO: 1.5 },
      }, {
        serverName: 'typed-http',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:1/mcp',
        headers: { 'X-Strong': 42 },
      }],
    });
    check('schema 接受数字与布尔', true);
  } catch (error) {
    check('schema 接受数字与布尔', false, String((error && error.message) || error));
  }

  if (normalized) {
    const { ctx, mounted } = makeCtx();
    await apply(ctx, normalized);
    check('两台都挂上了', mounted.length === 2, `mounted=${mounted.length}`);
    const stdio = mounted[0] && mounted[0].config;
    const http = mounted[1] && mounted[1].config;
    check('args 全部字符串化', stdio && stdio.args.join(',') === 'a,2,true', JSON.stringify(stdio && stdio.args));
    check('env 数字字符串化', stdio && stdio.env.PORT === '8080', JSON.stringify(stdio && stdio.env));
    check('env 布尔字符串化', stdio && stdio.env.DEBUG === 'true');
    check('env 浮点字符串化', stdio && stdio.env.RATIO === '1.5');
    check('env 字符串原样', stdio && stdio.env.NAME === 'x');
    check('headers 数字字符串化', http && http.headers['X-Strong'] === '42', JSON.stringify(http && http.headers));
  }
}

console.log('[H] servers 是 volatile 引用；设置页写入后靠 loader/volatile-update 重挂载');
{
  // settings 服务只把「schema 里带 volatile 字段」的活跃条目投影成命名空间，
  // 所以这里是「插件能被设置页列出并可写」的前提。
  const parsed = Config({ servers: [{ serverName: 'alpha', command: 'node' }] });
  check('schema 里 servers 标了 volatile', Config.dict.servers.meta.volatile === true);
  check(
    'servers 解析成 Volatile 引用',
    parsed.servers !== null && typeof parsed.servers === 'object' && typeof parsed.servers.get === 'function',
    JSON.stringify(parsed.servers),
  );
  check('servers.get() 是数组', Array.isArray(parsed.servers.get()), JSON.stringify(parsed.servers && parsed.servers.get()));

  const { ctx, logs, mounted, handlers, disposedCount } = makeCtx();
  await apply(ctx, parsed);
  check('初次挂载 1 台', mounted.length === 1, `mounted=${mounted.length}`);
  check('初次挂载的是 alpha', mounted[0] && mounted[0].config.serverName === 'alpha');
  check('注册了 loader/volatile-update 监听', handlers.has('loader/volatile-update'));
  check('初次挂载没有 warn', warnText(logs) === '', warnText(logs));

  // 模拟 Loader 的提交：就地更新同一个引用（cosmokit updateVolatile），再触发事件。
  const canReplace = cosmokit !== undefined
    && typeof cosmokit.updateVolatile === 'function'
    && typeof cosmokit.createVolatile === 'function';
  if (canReplace) {
    cosmokit.updateVolatile(parsed.servers, cosmokit.createVolatile([{ serverName: 'beta', command: 'node' }]));
    check('引用被就地更新', parsed.servers.get()[0].serverName === 'beta', JSON.stringify(parsed.servers.get()));
  }
  check('监听器是函数', typeof handlers.get('loader/volatile-update') === 'function');
  handlers.get('loader/volatile-update')([['servers']]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  check('旧实例被 dispose', disposedCount() === 1, `disposed=${disposedCount()}`);
  check('重挂载后累计 2 个实例', mounted.length === 2, `mounted=${mounted.length}`);
  if (canReplace) {
    check('重挂载读到的是新值 beta', mounted[1] && mounted[1].config.serverName === 'beta', mounted[1] && mounted[1].config.serverName);
  }
  check('重挂载没有 warn', warnText(logs) === '', warnText(logs));
}

console.log('[I] env / headers 的密钥引用在挂载前解析，持久化那份只留引用文本');
{
  const ENV_KEY = 'DSH_MCP_MANAGER_SELFTEST_TOKEN';
  process.env[ENV_KEY] = 'from-process-env';

  const config = Config({
    servers: [{
      serverName: 'with-refs',
      transport: 'stdio',
      command: 'node',
      env: {
        FROM_ENV: `env:${ENV_KEY}`,
        FROM_CRED: 'cred:selftest_cred',
        NOT_SET: 'env:DSH_MCP_MANAGER_SELFTEST_MISSING',
        UNKNOWN_CRED: 'cred:selftest_unknown',
        PLAIN: 'plain-value',
        // 引用名的字符集是 [A-Za-z_][A-Za-z0-9_]*，带连字符的名字不算引用。
        NOT_A_REF: 'cred:selftest-cred',
      },
    }, {
      serverName: 'refs-http',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'cred:selftest_cred', 'X-Plain': 'v' },
    }],
  });

  const { ctx, logs, mounted } = makeCtx();
  // 只提供 credentials，其余服务照旧缺省。
  ctx.get = (service) => (service === 'credentials'
    ? { resolve: async (secretName) => (secretName === 'selftest_cred' ? { value: 'from-credentials-service' } : undefined) }
    : undefined);

  await apply(ctx, config);

  check('两台都挂上了', mounted.length === 2, `mounted=${mounted.length}`);
  const stdio = mounted[0] && mounted[0].config;
  const http = mounted[1] && mounted[1].config;

  check('env: 解析成进程环境变量', stdio && stdio.env.FROM_ENV === 'from-process-env', JSON.stringify(stdio && stdio.env));
  check('cred: 解析成凭据值', stdio && stdio.env.FROM_CRED === 'from-credentials-service', JSON.stringify(stdio && stdio.env));
  check('未设置的 env: 保留字面值', stdio && stdio.env.NOT_SET === 'env:DSH_MCP_MANAGER_SELFTEST_MISSING', JSON.stringify(stdio && stdio.env));
  check('未配置的 cred: 保留字面值', stdio && stdio.env.UNKNOWN_CRED === 'cred:selftest_unknown');
  check('普通值原样透传', stdio && stdio.env.PLAIN === 'plain-value');
  check('名字带连字符的不算引用', stdio && stdio.env.NOT_A_REF === 'cred:selftest-cred');
  check('headers 里的 cred: 同样解析', http && http.headers.Authorization === 'from-credentials-service', JSON.stringify(http && http.headers));
  check('headers 里的普通值原样', http && http.headers['X-Plain'] === 'v');

  const warns = warnText(logs);
  check('未设置的 env 有告警', warns.includes('环境变量 DSH_MCP_MANAGER_SELFTEST_MISSING 未设置'), warns);
  check('未配置的凭据有告警', warns.includes('凭据 selftest_unknown 未配置'), warns);

  // 关键：解析只发生在交给 mcp-client 的那份副本上。
  const persisted = config.servers.get()[0];
  check(
    '持久化配置里仍是引用文本',
    persisted.env.FROM_ENV === `env:${ENV_KEY}` && persisted.env.FROM_CRED === 'cred:selftest_cred',
    JSON.stringify(persisted.env),
  );

  delete process.env[ENV_KEY];
}

console.log('[J] credentials 服务缺失时 cred: 引用不崩，保留字面值');
{
  const { ctx, logs, mounted } = makeCtx();
  await apply(ctx, {
    servers: [{ serverName: 'no-cred-svc', command: 'node', env: { T: 'cred:whatever' } }],
  });
  check('照常挂载', mounted.length === 1, `mounted=${mounted.length}`);
  check('引用保留字面值', mounted[0].config.env.T === 'cred:whatever', JSON.stringify(mounted[0].config.env));
  check('给出告警', warnText(logs).includes('credentials 服务不可用'), warnText(logs));
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
