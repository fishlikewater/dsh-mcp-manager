// 端到端冒烟测试：内存 Cordis 上下文 + 假 settings/tools/webServer 服务 +
// 极简 stdio MCP 服务器（fixtures/fake-mcp-server.mjs，放 test/ 外以免被
// node --test 默认发现规则当作测试文件执行），走真实 HTTP 接口验证
// 「配置保存即生效」全链路：
//   POST /api/mcp/servers → settings 提交 → settings/updated → 挂载
//   mcp-client → 连接假服务器 → ctx.tools 注册 mcp__\<名称\>__\<工具\>。
// 同时覆盖：真实挂载状态跟踪（日志截获）、rev 乐观锁（409）、enabled 开关、
// 密钥引用保留、failOnStartupError、toolCallTimeoutMs 自定义。
//
// 注意：dsh-mcp-client 内部使用 Promise.withResolvers（Node 22+），在
// Node 18/20 的 CI 矩阵里先做等价 polyfill 再加载。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import * as Manager from '../index.js';

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const FAKE_SERVER = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const STDIO = (name, extra = {}) => ({
  serverName: name,
  enabled: true,
  transport: 'stdio',
  command: process.execPath,
  args: [FAKE_SERVER],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  ...extra,
});

// ── 假服务 ───────────────────────────────────────────────────────────────

// 最小 settings 服务：register/get/replace（带 rev + 冲突）/describe，
// replace 提交后按 dsh-settings 语义 emit settings/updated（值变化才发）。
class FakeSettings extends Service {
  registrations = new Map();
  document = {};

  constructor(ctx) {
    super(ctx, 'settings');
  }

  register(ns, schema) {
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    const registration = {
      ns,
      schema,
      resolved: schema(this.document[ns]),
      revision: 0,
    };
    this.ctx.effect(() => {
      this.registrations.set(ns, registration);
      return () => this.registrations.delete(ns);
    }, `settings.register(${JSON.stringify(ns)})`);
    return { get: () => registration.resolved, replace: (section) => this.replace(ns, section) };
  }

  get(ns) {
    return this.registrations.get(ns)?.resolved;
  }

  describe() {
    return [...this.registrations.values()].map((r) => ({ ns: r.ns, revision: r.revision }));
  }

  async replace(ns, section, expectedRevision) {
    const registration = this.registrations.get(ns);
    if (!registration) throw new Error(`settings namespace "${ns}" is not registered`);
    if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
      const error = new Error(
        `settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${registration.revision})`,
      );
      error.name = 'SettingsConflictError';
      error.code = 'SETTINGS_CONFLICT';
      error.expected = expectedRevision;
      error.actual = registration.revision;
      throw error;
    }
    const before = this.document[ns];
    this.document[ns] = section;
    const next = registration.schema(section);
    if (JSON.stringify(before) !== JSON.stringify(section)) registration.revision += 1;
    if (JSON.stringify(next) !== JSON.stringify(registration.resolved)) {
      registration.resolved = next;
      this.ctx.emit('settings/updated', ns, next);
    }
    return next;
  }
}

// mcp-client 只消费 ctx.tools.register(definition)（返回 disposer）。
class FakeTools extends Service {
  defs = new Map();

  constructor(ctx) {
    super(ctx, 'tools');
  }

  register(definition) {
    this.defs.set(definition.name, definition);
    return () => this.defs.delete(definition.name);
  }
}

// webServer：把路由挂到真实 http.Server 上，handler 收到真实 Node req/res。
class FakeWebServer extends Service {
  routes = new Map();
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://internal').pathname;
    const handler = this.routes.get(`exact ${pathname}`);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{}');
      return;
    }
    handler(req, res);
  });

  constructor(ctx) {
    super(ctx, 'webServer');
  }

  register(route) {
    this.routes.set(`${route.kind} ${route.path}`, route.handler);
    return () => this.routes.delete(`${route.kind} ${route.path}`);
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this.server.address().port;
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ── 测试主体 ─────────────────────────────────────────────────────────────

function buildHarness() {
  const app = new Context();
  const settings = new FakeSettings(app);
  const tools = new FakeTools(app);
  const webServer = new FakeWebServer(app);
  return { app, settings, tools, webServer };
}

async function waitFor(fn, { timeout = 10000, interval = 50, label = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function request(base, method, body) {
  const response = await fetch(base, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

describe('端到端：保存即生效（内存 cordis + 假 stdio MCP 服务器）', () => {
  let harness;
  let base;
  let disposer;

  before(async () => {
    harness = buildHarness();
    disposer = harness.app.plugin(Manager);
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`;
  });

  after(async () => {
    await harness.webServer.close();
    await disposer.dispose();
  });

  it('初始 GET：rev 0、空列表、空状态', async () => {
    const { status, data } = await request(base, 'GET');
    assert.equal(status, 200);
    assert.equal(data.rev, 0);
    assert.deepEqual(data.servers, []);
    assert.deepEqual(data.status, {});
  });

  it('POST 添加 stdio 服务器 → 工具注册（保存即生效全链路）', async () => {
    const { status } = await request(base, 'POST', { servers: [STDIO('fake')] });
    assert.equal(status, 200);
    const toolName = await waitFor(
      () => harness.tools.defs.has('mcp__fake__echo') && harness.tools.defs.get('mcp__fake__echo'),
      { label: 'mcp__fake__echo 注册' },
    );
    assert.equal(toolName.name, 'mcp__fake__echo');

    const get = await request(base, 'GET');
    assert.equal(get.data.status.fake.state, 'ok', JSON.stringify(get.data.status));
  });

  it('状态跟踪：不存在的命令 → 状态 error（日志截获驱动，异步真实失败）', async () => {
    await request(base, 'POST', {
      servers: [
        STDIO('fake'),
        STDIO('broken', { command: '/nonexistent-binary-xyz', failOnStartupError: true }),
      ],
    });
    const brokenStatus = await waitFor(async () => {
      const get = await request(base, 'GET');
      return get.data.status.broken && get.data.status.broken.state === 'error'
        ? get.data.status.broken
        : undefined;
    }, { label: 'broken 状态变为 error' });
    assert.match(brokenStatus.message, /连接失败|启动失败/);

    // fake 服务器不受影响
    const get = await request(base, 'GET');
    assert.equal(get.data.status.fake.state, 'ok');
  });

  it('rev 乐观锁：旧 rev 提交返回 409 conflict；新 rev 成功且 rev 递增', async () => {
    const before = await request(base, 'GET');
    const rev = before.data.rev;
    const server = STDIO('fake2');
    const ok = await request(base, 'POST', { rev, servers: [...before.data.servers, server] });
    assert.equal(ok.status, 200);

    // 用旧 rev 再提交 → 409
    const conflict = await request(base, 'POST', {
      rev,
      servers: [...before.data.servers, STDIO('fake3')],
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'conflict');

    const after = await request(base, 'GET');
    assert.equal(after.data.rev, rev + 1);
    assert.ok(after.data.servers.some((s) => s.serverName === 'fake2'));
    assert.ok(!after.data.servers.some((s) => s.serverName === 'fake3'));
  });

  it('enabled 开关：关闭后工具移除、状态 disabled；开启恢复', async () => {
    const current = await request(base, 'GET');
    const off = current.data.servers.map((s) => (s.serverName === 'fake2' ? { ...s, enabled: false } : s));
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: off });
    assert.equal(status, 200);

    await waitFor(() => !harness.tools.defs.has('mcp__fake2__echo'), { label: '关闭后工具移除' });
    const getOff = await request(base, 'GET');
    assert.equal(getOff.data.status.fake2.state, 'disabled');

    // 开启恢复
    const current2 = await request(base, 'GET');
    const on = current2.data.servers.map((s) => (s.serverName === 'fake2' ? { ...s, enabled: true } : s));
    await request(base, 'POST', { rev: current2.data.rev, servers: on });
    await waitFor(() => harness.tools.defs.has('mcp__fake2__echo'), { label: '开启后工具恢复' });
  });

  it('toolCallTimeoutMs / failOnStartupError 可配置并随配置往返', async () => {
    const current = await request(base, 'GET');
    const updated = current.data.servers.map((s) => (s.serverName === 'fake' ? { ...s, toolCallTimeoutMs: 5000, failOnStartupError: true } : s));
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: updated });
    assert.equal(status, 200);
    const get = await request(base, 'GET');
    const server = get.data.servers.find((s) => s.serverName === 'fake');
    assert.equal(server.toolCallTimeoutMs, 5000);
    assert.equal(server.failOnStartupError, true);
    // 实例仍活着
    assert.equal(get.data.status.fake.state, 'ok');
  });

  it('密钥引用：未配置的 env/cred 引用保留字面值且不阻断挂载', async () => {
    const current = await request(base, 'GET');
    const updated = current.data.servers.map((s) => (
      s.serverName === 'fake2'
        ? { ...s, env: { FOO: 'env:MISSING_ENV_XYZ', BAR: 'cred:MISSING_CRED_XYZ' } }
        : s
    ));
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: updated });
    assert.equal(status, 200);
    const get = await request(base, 'GET');
    const server = get.data.servers.find((s) => s.serverName === 'fake2');
    assert.equal(server.env.FOO, 'env:MISSING_ENV_XYZ');
    await waitFor(() => harness.tools.defs.has('mcp__fake2__echo'), { label: '带引用的服务器仍挂载' });
  });

  it('校验：非法 toolCallTimeoutMs / 重复 serverName 被 400 拒绝', async () => {
    const badTimeout = await request(base, 'POST', {
      servers: [STDIO('x', { toolCallTimeoutMs: 0 })],
    });
    assert.equal(badTimeout.status, 400);
    assert.match(badTimeout.data.error, /toolCallTimeoutMs/);

    const dup = await request(base, 'POST', {
      servers: [STDIO('fake'), STDIO('fake')],
    });
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /重复/);
  });
});