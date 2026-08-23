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
});