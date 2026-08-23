// 兼容性契约测试：本插件构造的 mcp-client 实例配置必须能被正在使用的
// @deepseek-ai/dsh-mcp-client Config schema 接受（schemastery schema 可直接
// 调用校验：Config(config) 校验并返回归一化结果，不合法时抛错）。
//
// CI 里该测试跑在版本矩阵上（Node 18/20/22 × dsh-mcp-client
// 0.1.0-rc.6 / 0.1.0-rc.8 / 0.1.1-rc.2），任一版本改了配置契约而本插件
// 没跟上时，这里会先红。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '@deepseek-ai/dsh-mcp-client';
import { buildClientConfig } from '../lib/logic.js';

describe('buildClientConfig 产出与 mcp-client Config schema 兼容', () => {
  it('stdio 完整配置通过校验，缺省字段被归一化', () => {
    const config = buildClientConfig({
      serverName: 'local', enabled: true, transport: 'stdio',
      command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp',
      url: '', headers: {},
    });
    const parsed = Config(config);
    assert.equal(parsed.transport, 'stdio');
    assert.equal(parsed.serverName, 'local');
    assert.equal(parsed.command, 'npx');
    assert.deepEqual(parsed.args, ['-y', 'pkg']);
    assert.deepEqual(parsed.env, { A: '1' });
    assert.equal(parsed.cwd, '/tmp');
    assert.equal(parsed.toolCallTimeoutMs, 60000);
    assert.equal(parsed.failOnStartupError, false);
  });

  it('stdio 最小配置（只有 command）也通过校验', () => {
    const config = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'echo hi' });
    const parsed = Config(config);
    assert.equal(parsed.cwd, '');
    assert.deepEqual(parsed.args, []);
    assert.deepEqual(parsed.env, {});
  });

  it('streamable-http 配置通过校验', () => {
    const config = buildClientConfig({
      serverName: 'remote', transport: 'streamable-http',
      url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer t' },
    });
    const parsed = Config(config);
    assert.equal(parsed.transport, 'streamable-http');
    assert.equal(parsed.url, 'http://localhost:3000/mcp');
    assert.deepEqual(parsed.headers, { Authorization: 'Bearer t' });
  });

  it('schema 校验不是摆设：必填缺失/transport 非法时抛错', () => {
    assert.throws(() => Config({ transport: 'stdio', serverName: 'x' }));
    assert.throws(() => Config({ transport: 'bogus', serverName: 'x' }));
    assert.throws(() => Config({ transport: 'stdio', serverName: 'bad name', command: 'x' }));
  });

  it('多余键不会被拒绝（会保留）——buildClientConfig 必须只输出契约内键', () => {
    const out = Config({ transport: 'stdio', serverName: 'x', command: 'echo', extraKey: 123 });
    assert.equal(out.extraKey, 123);
  });
});