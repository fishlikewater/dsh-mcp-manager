// 客户端 bundle 兼容性测试：把 client.js（浏览器模块加载器格式的手写 bundle）
// 加载进 vm 沙箱，验证解析/组装助手行为，以及「客户端表单产出 → 宿主侧校验」
// 的往返契约。沙箱里不执行 apply()，只消费导出。

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { validateServers, buildClientConfig } from '../lib/logic.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function loadClientBundle() {
  let captured = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (mod) => { captured = mod; },
      },
    },
    document: {
      createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
      head: { appendChild: () => {} },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load');
  const mod = captured.factory((name) => {
    if (name === 'react') {
      return {
        useState: (init) => [init, () => {}],
        useEffect: () => {},
        createElement: () => ({}),
      };
    }
    throw new Error(`测试沙箱不支持 require('${name}')`);
  });
  return mod;
}

const client = loadClientBundle();

// vm 沙箱里创建的对象属于沙箱 realm，原型与宿主不同，deepStrictEqual 永远
// 不相等；这里把沙箱值复制成宿主 realm 的普通对象/数组再比较。
function host(value) {
  if (Array.isArray(value)) return Array.from(value);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = value[key];
    return out;
  }
  return value;
}

describe('client bundle 契约', () => {
  it('导出 apply/inject 以外的解析与组装助手', () => {
    for (const key of ['apply', 'parseLines', 'parseEnv', 'parseHeaders', 'joinEntries', 'buildServerObject']) {
      assert.equal(typeof client[key], 'function', key);
    }
    assert.ok(Array.isArray(client.inject), 'inject 应为数组');
  });
});

describe('parseLines', () => {
  it('兼容 \\n 与 \\r\\n 混排，去空行去首尾空白', () => {
    assert.deepEqual(host(client.parseLines(' a \r\n\r\n  b\nc  ')), ['a', 'b', 'c']);
  });
  it('空输入 → []', () => {
    assert.deepEqual(host(client.parseLines(undefined)), []);
    assert.deepEqual(host(client.parseLines('')), []);
  });
});

describe('parseEnv', () => {
  it('KEY=VALUE 解析并 trim', () => {
    assert.deepEqual(host(client.parseEnv(' A = 1 \nB = x=y z')), { A: '1', B: 'x=y z' });
  });
  it('无 = 的行被跳过', () => {
    assert.deepEqual(host(client.parseEnv('A=1\nbogus\n')), { A: '1' });
  });
});

describe('parseHeaders', () => {
  it('同时接受 KEY: VALUE 与 KEY=VALUE', () => {
    assert.deepEqual(host(client.parseHeaders('Authorization: Bearer t\nX-Api = k')), {
      Authorization: 'Bearer t',
      'X-Api': 'k',
    });
  });
  it('= 比 : 优先（两者都出现时取更靠前的分隔符）', () => {
    assert.equal(client.parseHeaders('A=b:c')['A'], 'b:c');
  });
  it('无分隔符的行被跳过', () => {
    assert.deepEqual(host(client.parseHeaders('just-a-line\nB: v')), { B: 'v' });
  });
});

describe('joinEntries × parseEnv 往返', () => {
  it('对象 → 文本 → 对象 无损', () => {
    const original = { A: '1', B: 'x=y' };
    assert.deepEqual(host(client.parseEnv(client.joinEntries(original))), original);
  });
});

describe('buildServerObject（表单 → 服务器对象）', () => {
  const form = () => ({
    serverName: '  my-srv  ', transport: 'stdio', command: 'npx',
    args: '-y\npkg', env: 'A=1\nB=2', cwd: ' /tmp ', url: '', headers: '',
  });

  it('trim serverName/cwd/url，不做 command；enabled 默认 true（新建）', () => {
    const server = client.buildServerObject(form(), {});
    assert.equal(server.serverName, 'my-srv');
    assert.equal(server.command, 'npx');
    assert.equal(server.cwd, '/tmp');
    assert.equal(server.enabled, true);
    assert.deepEqual(host(server.args), ['-y', 'pkg']);
    assert.deepEqual(host(server.env), { A: '1', B: '2' });
  });

  it('编辑时保留原 enabled（关闭中的服务器保存后仍关闭）', () => {
    const server = client.buildServerObject(form(), { enabled: false });
    assert.equal(server.enabled, false);
  });
});

describe('客户端 → 宿主往返契约', () => {
  it('表单产出的 stdio/http 服务器都能通过宿主校验并构造 mcp-client 配置', () => {
    const stdio = client.buildServerObject({
      serverName: 'local', transport: 'stdio', command: 'npx',
      args: '-y\npkg', env: 'TOKEN=abc', cwd: '/work', url: '', headers: '',
    }, {});
    const http = client.buildServerObject({
      serverName: 'remote', transport: 'streamable-http', url: '  http://localhost:3000/mcp  ',
      headers: 'Authorization: Bearer t', command: '', args: '', env: '', cwd: '',
    }, {});
    assert.equal(validateServers([stdio, http]), null);
    assert.equal(buildClientConfig(stdio).command, 'npx');
    assert.equal(buildClientConfig(http).url, 'http://localhost:3000/mcp');
  });

  it('漏填必填字段的客户端产物被宿主侧拒绝（信息一致）', () => {
    const broken = client.buildServerObject({
      serverName: 'local', transport: 'stdio', command: '  ',
      args: '', env: '', cwd: '', url: '', headers: '',
    }, {});
    assert.match(validateServers([broken]), /必须提供 command/);
  });
});