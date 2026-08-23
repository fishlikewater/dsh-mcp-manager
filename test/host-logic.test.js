// 宿主侧纯逻辑单测：settings schema、HTTP 校验、mcp-client 配置构造、配置指纹。
// 不依赖 Cordis 运行时，只依赖 lib/logic.js。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_NAME_PATTERN,
  ServersSchema,
  validateServers,
  buildClientConfig,
  serverKey,
  mcpClientLogToStatus,
  substituteSecretRefs,
  SECRET_REF_PATTERN,
} from '../lib/logic.js';

describe('SERVER_NAME_PATTERN', () => {
  const valid = ['github', 'my_db', 'a-b', 'a1B_-', '0', 'x'.repeat(32)];
  const invalid = ['', 'a b', '中文', 'a.b', 'x'.repeat(33), 'a#b'];

  for (const name of valid) {
    it(`接受 ${JSON.stringify(name)}`, () => {
      assert.match(name, SERVER_NAME_PATTERN);
    });
  }
  for (const name of invalid) {
    it(`拒绝 ${JSON.stringify(name)}`, () => {
      assert.doesNotMatch(name, SERVER_NAME_PATTERN);
    });
  }
});

describe('ServersSchema（settings 命名空间契约）', () => {
  it('空对象归一化为空列表', () => {
    assert.deepEqual(ServersSchema({}).servers, []);
  });

  it('保留用户的 enabled: false（开关状态持久化契约）', () => {
    const value = ServersSchema({
      servers: [{ serverName: 'srv', transport: 'stdio', command: 'echo hi', enabled: false }],
    });
    assert.equal(value.servers[0].enabled, false);
  });

  it('缺失字段按默认值补齐', () => {
    const value = ServersSchema({
      servers: [{ serverName: 'srv', transport: 'stdio', command: 'echo hi' }],
    });
    const server = value.servers[0];
    assert.equal(server.enabled, true);
    assert.deepEqual(server.args, []);
    assert.deepEqual(server.env, {});
    assert.equal(server.cwd, '');
    assert.deepEqual(server.headers, {});
    assert.equal(server.url, '');
    assert.equal(server.toolCallTimeoutMs, 60000);
    assert.equal(server.failOnStartupError, false);
  });

  it('可配置项（超时/启动失败即报错）随 schema 归一化', () => {
    const value = ServersSchema({
      servers: [{ serverName: 'srv', transport: 'stdio', command: 'echo hi', toolCallTimeoutMs: 5000, failOnStartupError: true }],
    });
    assert.equal(value.servers[0].toolCallTimeoutMs, 5000);
    assert.equal(value.servers[0].failOnStartupError, true);
  });
});

describe('validateServers（HTTP 接口校验）', () => {
  it('非数组被拒绝', () => {
    assert.match(validateServers({}), /必须是数组/);
  });

  it('非对象条目被拒绝', () => {
    assert.match(validateServers([null]), /必须是一个对象/);
  });

  it('serverName 非法/重复被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a b', transport: 'stdio', command: 'x' }]), /serverName 无效/);
    const one = () => ({ serverName: 'a', transport: 'stdio', command: 'x' });
    assert.match(validateServers([one(), one()]), /重复/);
  });

  it('enabled 非布尔被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', enabled: 'yes' }]),
      /enabled 必须是布尔值/,
    );
  });

  it('toolCallTimeoutMs 非正数/非数字被拒绝', () => {
    for (const bad of [0, -1, '5000', NaN, Infinity]) {
      assert.match(
        validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', toolCallTimeoutMs: bad }]),
        /toolCallTimeoutMs 必须是 >= 1 的数字/,
        String(bad),
      );
    }
  });

  it('failOnStartupError 非布尔被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', failOnStartupError: 'yes' }]),
      /failOnStartupError 必须是布尔值/,
    );
  });

  it('新字段缺省（undefined/null）时容忍', () => {
    assert.equal(validateServers([
      { serverName: 'a', transport: 'stdio', command: 'x', toolCallTimeoutMs: null, failOnStartupError: null },
    ]), null);
  });

  it('stdio 缺 command 被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: '  ' }]),
      /必须提供 command/,
    );
  });

  it('streamable-http 缺 url 被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'streamable-http', url: '' }]),
      /必须提供 url/,
    );
  });

  it('未知 transport 被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a', transport: 'ssh' }]), /transport 无效/);
  });

  it('合法的 stdio 与 http 均通过', () => {
    assert.equal(validateServers([
      { serverName: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      { serverName: 'remote', transport: 'streamable-http', url: 'http://localhost:3000/mcp' },
    ]), null);
  });

  it('enabled 为 null 时容忍（等价于默认 true）', () => {
    assert.equal(validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', enabled: null }]), null);
  });
});

describe('buildClientConfig（mcp-client 实例配置契约）', () => {
  it('stdio：只输出契约内的键', () => {
    const config = buildClientConfig({
      serverName: 'local', enabled: true, transport: 'stdio',
      command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp',
      url: '', headers: {},
    });
    assert.deepEqual(Object.keys(config).sort(), [
      'args', 'command', 'cwd', 'env', 'failOnStartupError', 'serverName',
      'toolCallTimeoutMs', 'transport',
    ]);
    assert.equal(config.command, 'npx');
    assert.deepEqual(config.args, ['-y', 'pkg']);
    assert.deepEqual(config.env, { A: '1' });
    assert.equal(config.cwd, '/tmp');
    assert.equal(config.toolCallTimeoutMs, 60000);
    assert.equal(config.failOnStartupError, false);
  });

  it('stdio：可选字段缺省时省略/取默认，cwd 为空时省略', () => {
    const config = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'echo hi' });
    assert.equal(config.cwd, undefined);
    assert.deepEqual(config.args, []);
    assert.deepEqual(config.env, {});
  });

  it('stdio：env/args 非对象输入被清洗为默认值', () => {
    const config = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', env: 'oops', args: 'oops' });
    assert.deepEqual(config.env, {});
    assert.deepEqual(config.args, []);
  });

  it('自定义 toolCallTimeoutMs / failOnStartupError 透传；非法时回落默认', () => {
    const config = buildClientConfig({
      serverName: 'local', transport: 'stdio', command: 'x',
      toolCallTimeoutMs: 3000, failOnStartupError: true,
    });
    assert.equal(config.toolCallTimeoutMs, 3000);
    assert.equal(config.failOnStartupError, true);

    assert.equal(buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', toolCallTimeoutMs: NaN }).toolCallTimeoutMs, 60000);
    assert.equal(buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', toolCallTimeoutMs: 0 }).toolCallTimeoutMs, 60000);
    assert.equal(buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', failOnStartupError: 'yes' }).failOnStartupError, false);
  });

  it('streamable-http：只输出契约内的键', () => {
    const config = buildClientConfig({
      serverName: 'remote', enabled: true, transport: 'streamable-http',
      url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer t' },
      command: '', args: [], env: {}, cwd: '',
    });
    assert.deepEqual(Object.keys(config).sort(), [
      'failOnStartupError', 'headers', 'serverName', 'toolCallTimeoutMs',
      'transport', 'url',
    ]);
    assert.equal(config.url, 'http://localhost:3000/mcp');
    assert.deepEqual(config.headers, { Authorization: 'Bearer t' });
  });

  it('streamable-http：headers 非对象输入被清洗为 {}', () => {
    const config = buildClientConfig({ serverName: 'remote', transport: 'streamable-http', url: 'u', headers: null });
    assert.deepEqual(config.headers, {});
  });
});

describe('serverKey（配置指纹）', () => {
  const base = { serverName: 's', enabled: true, transport: 'stdio', command: 'x', args: [], env: {}, cwd: '', url: '', headers: {} };

  it('相同配置指纹相同（忽略键顺序）', () => {
    assert.equal(serverKey(base), serverKey({ ...base, dummy: 1 }));
  });

  it('enabled 翻转改变指纹（开关切换可被识别）', () => {
    assert.notEqual(serverKey(base), serverKey({ ...base, enabled: false }));
  });

  it('任意业务字段变化改变指纹', () => {
    for (const field of ['command', 'transport', 'url', 'cwd']) {
      assert.notEqual(serverKey(base), serverKey({ ...base, [field]: 'changed' }), field);
    }
  });

  it('新增可配置项参与指纹（改超时/报错开关会触发重建）', () => {
    assert.notEqual(serverKey(base), serverKey({ ...base, toolCallTimeoutMs: 3000 }));
    assert.notEqual(serverKey(base), serverKey({ ...base, failOnStartupError: true }));
  });
});

describe('mcpClientLogToStatus（mcp-client 日志 → 挂载状态）', () => {
  const log = (args, name = 'mcp-client') => ({ name, type: 'warn', level: 2, args });

  it('连接尝试失败 → error（带原因）', () => {
    const update = mcpClientLogToStatus(log(['mcp-client(github): connection attempt failed: spawn /nope ENOENT']));
    assert.deepEqual(update, { serverName: 'github', state: 'error', message: '连接失败：spawn /nope ENOENT' });
  });

  it('重试中 / 重连中 → error', () => {
    assert.deepEqual(
      mcpClientLogToStatus(log(['mcp-client(a): connection failed; retrying in 500ms (attempt 1/10)'])),
      { serverName: 'a', state: 'error', message: '连接失败，重试中…' },
    );
    assert.deepEqual(
      mcpClientLogToStatus(log(['mcp-client(a): connection lost; reconnecting in 1000ms (attempt 2/10)'])),
      { serverName: 'a', state: 'error', message: '连接中断，重连中…' },
    );
  });

  it('重连成功 → ok', () => {
    assert.deepEqual(
      mcpClientLogToStatus(log(['mcp-client(a): reconnected and re-synced tools (attempt 3/10)'])),
      { serverName: 'a', state: 'ok', message: '' },
    );
  });

  it('放弃重连 / 重连被禁用 / 工具注册失败 → error', () => {
    assert.equal(mcpClientLogToStatus(log(['mcp-client(a): giving up after 10 consecutive failed reconnect attempts — tools unregistered'])).state, 'error');
    assert.equal(mcpClientLogToStatus(log(['mcp-client(a): connection failed and reconnect is disabled — no tools were registered'])).state, 'error');
    assert.equal(mcpClientLogToStatus(log(['mcp-client(a): connection lost and reconnect is disabled — registered tools will fail'])).state, 'error');
    const reg = mcpClientLogToStatus(log(['mcp-client(a): tool registration failed, no tools registered: boom']));
    assert.equal(reg.state, 'error');
    assert.match(reg.message, /工具注册失败：boom/);
  });

  it('无关日志 / 其他 logger 名 → null', () => {
    assert.equal(mcpClientLogToStatus(log(['mcp-client(a): tool list changed, re-syncing'])), null);
    assert.equal(mcpClientLogToStatus(log(['dsh-mcp-manager: 随便一条日志'])), null);
    assert.equal(mcpClientLogToStatus(log(['其他内容'])), null);
    assert.equal(mcpClientLogToStatus(null), null);
    assert.equal(mcpClientLogToStatus({ name: 'mcp-client', type: 'info', level: 1, args: [] }), null);
  });
});

describe('substituteSecretRefs（密钥引用解析，不入盘）', () => {
  it('env:/cred: 引用被替换，非引用值原样保留', async () => {
    const config = {
      serverName: 's', transport: 'stdio', command: 'x',
      env: { A: 'env:TOKEN', B: 'cred:API_KEY', C: 'plain', D: 'cred:bad name' },
      headers: { Authorization: 'cred:API_KEY', X: 'env:TOKEN' },
    };
    const resolved = await substituteSecretRefs(config, async (name, kind) => {
      if (name === 'TOKEN') return 'secret-env';
      if (name === 'API_KEY' && kind === 'cred') return 'secret-cred';
      return undefined;
    });
    assert.deepEqual(resolved.env, { A: 'secret-env', B: 'secret-cred', C: 'plain', D: 'cred:bad name' });
    assert.deepEqual(resolved.headers, { Authorization: 'secret-cred', X: 'secret-env' });
    // 入参不被修改
    assert.equal(config.env.A, 'env:TOKEN');
  });

  it('解析失败（未配置）保留字面值', async () => {
    const config = { serverName: 's', transport: 'stdio', command: 'x', env: { A: 'env:MISSING' } };
    const resolved = await substituteSecretRefs(config, async () => undefined);
    assert.equal(resolved.env.A, 'env:MISSING');
  });

  it('解析器可以是同步函数', async () => {
    const resolved = await substituteSecretRefs({ serverName: 's', transport: 'stdio', command: 'x', env: { A: 'env:TOKEN' } }, (name) => `v:${name}`);
    assert.equal(resolved.env.A, 'v:TOKEN');
  });

  it('SECRET_REF_PATTERN 只接受合法引用名', () => {
    assert.match('env:TOKEN', SECRET_REF_PATTERN);
    assert.match('cred:MY_KEY_2', SECRET_REF_PATTERN);
    assert.doesNotMatch('env:1BAD', SECRET_REF_PATTERN);
    assert.doesNotMatch('env:BAD-NAME', SECRET_REF_PATTERN);
    assert.doesNotMatch('plain', SECRET_REF_PATTERN);
  });
});