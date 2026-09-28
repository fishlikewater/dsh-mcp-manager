// dsh-mcp-manager — 客户端半 settings 通道自测（假 module loader + 假 Remote，无需 DOM）。
//
// 用法：node test/client.selftest.mjs
//
// 覆盖：通道缺失、describe 命中/未命中/被拒绝、mutate 成功/冲突/其它拒绝，
// 以及写入调用签名（三个位置参数、expectedRevision 缺省即无条件写）。
// 这层曾经写错过通道名与应答结构（0.3.0 的 connection.api.settings 根本不存在），
// 所以这里对「契约本身」做回归，而不只是做逻辑分支回归。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

let pass = 0;
let fail = 0;

function ok(label, condition) {
  if (condition) {
    pass += 1;
    console.log('  [ok] ' + label);
  } else {
    fail += 1;
    console.log('  [FAIL] ' + label);
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label + ' → ' + a, a === b);
}

async function throws(label, fn, needle) {
  try {
    await fn();
    ok(label + ' → 应抛错但没有', false);
  } catch (error) {
    const message = String((error && error.message) || error);
    ok(label + ' → ' + message, message.includes(needle));
  }
}

// ── 装载客户端 bundle（classic script，注册到 window.__ModuleLoader__）────────
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
};

// eslint-disable-next-line no-new-func
new Function(source)();
if (!captured) throw new Error('client.js 未调用 window.__ModuleLoader__.load');

// 只桩掉 factory 真正 require 的两个模块；其它请求视为契约漂移。
const stubs = {
  react: {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  },
  'react-dom': { createPortal: () => null },
};

const plugin = captured.factory((id) => {
  if (!(id in stubs)) throw new Error('客户端 bundle 请求了未预期的模块：' + id);
  return stubs[id];
});

ok('bundle id 是包名', captured.id === '@fishlikewater/dsh-mcp-manager');
eq('inject 声明 slots 与 remote 能力', plugin.inject, ['slots', 'remote', 'remote.settings']);
ok('导出了 apply 与 __test', typeof plugin.apply === 'function' && plugin.__test !== undefined);

const t = plugin.__test;

// ── A. 通道缺失 ─────────────────────────────────────────────────────────────
console.log('\nA. 通道缺失');
t.setRemote(null);
await throws('readNamespace 报通道不可用', () => t.readNamespace(), 'ctx.remote.settings 缺失');
await throws('saveServers 报通道不可用', () => t.saveServers([], 0), 'ctx.remote.settings 缺失');
t.setRemote({});
await throws('remote 无 settings 时报通道不可用', () => t.readNamespace(), 'ctx.remote.settings 缺失');

// ── B. describe 命中本命名空间 ───────────────────────────────────────────────
console.log('\nB. describe 命中');
let describeArgs = null;
let mutateCalled = false;
t.setRemote({
  settings: {
    describe(...args) {
      describeArgs = args;
      return {
        ok: true,
        value: {
          writable: true,
          namespaces: [
            { ns: 'other', value: {} },
            { ns: 'mcp-manager', value: { servers: [{ serverName: 'lanhu' }] }, revision: 7 },
          ],
        },
      };
    },
    mutate() { mutateCalled = true; throw new Error('读取路径不应调用 mutate'); },
  },
});
const namespace = await t.readNamespace();
eq('describe 无参调用', describeArgs, []);
ok('返回 ns 匹配的那一行', namespace !== null && namespace.ns === 'mcp-manager');
eq('读到 config.servers', namespace.value.servers, [{ serverName: 'lanhu' }]);
eq('读到 revision', namespace.revision, 7);
ok('读取路径未触发写入', mutateCalled === false);

// ── C. describe 未注册该命名空间 ─────────────────────────────────────────────
console.log('\nC. describe 未命中');
t.setRemote({ settings: { describe: () => ({ ok: true, value: { namespaces: [{ ns: 'other' }] } }) } });
eq('未注册时返回 null（页面据此提示）', await t.readNamespace(), null);

// ── D. describe 被宿主拒绝 ───────────────────────────────────────────────────
console.log('\nD. describe 被拒绝');
t.setRemote({
  settings: {
    describe: () => ({ ok: false, error: { code: 'settings/rejected', message: '没有可用的 settings provider' } }),
  },
});
await throws('抛出宿主给的 message', () => t.readNamespace(), '没有可用的 settings provider');

// ── E. mutate 成功与调用签名 ─────────────────────────────────────────────────
console.log('\nE. mutate 成功与调用签名');
let mutateArgs = null;
t.setRemote({
  settings: {
    mutate(...args) {
      mutateArgs = args;
      return { ok: true, value: { ns: 'mcp-manager', value: { servers: [] }, revision: 8 } };
    },
  },
});
const written = await t.saveServers([{ serverName: 'dbx' }], 7);
eq('mutate 收到三个位置参数', mutateArgs === null ? null : mutateArgs.length, 3);
eq('参数 1 = 命名空间', mutateArgs[0], 'mcp-manager');
eq('参数 2 = ops（整体 set servers）', mutateArgs[1], [{ op: 'set', path: ['servers'], value: [{ serverName: 'dbx' }] }]);
eq('参数 3 = 读到的 revision', mutateArgs[2], 7);
eq('返回写入后的视图', written, { ns: 'mcp-manager', value: { servers: [] }, revision: 8 });

// ── F. expectedRevision 缺省语义 ─────────────────────────────────────────────
console.log('\nF. expectedRevision 缺省');
for (const [label, revision] of [['revision 0', 0], ['revision undefined', undefined], ['revision null', null]]) {
  mutateArgs = null;
  await t.saveServers([], revision);
  ok(label + ' → 传 undefined（无条件写，避免伪冲突）', mutateArgs[2] === undefined);
}

// ── G. 冲突与其它拒绝 ────────────────────────────────────────────────────────
console.log('\nG. 写入被拒绝');
t.setRemote({
  settings: {
    mutate: () => ({ ok: false, error: { code: 'settings/conflict', message: 'revision 已过期' } }),
  },
});
await throws('settings/conflict 追加刷新提示', () => t.saveServers([], 3), '刷新后重试');

t.setRemote({
  settings: {
    mutate: () => ({ ok: false, error: { code: 'settings/rejected', message: '该部署只读' } }),
  },
});
try {
  await t.saveServers([], 3);
  ok('其它拒绝码应抛错但没有', false);
} catch (error) {
  ok('其它拒绝码原样抛出宿主消息 → ' + error.message, error.message === '该部署只读');
}

// ── H. 注入 CSS 与内联样式的主题跟随 ─────────────────────────────────────────
console.log('\nH. 注入 CSS 与内联样式的主题跟随');
const uiCss = t.buildUiCss();
ok('.mcp-select 显式声明亮色 color-scheme', /\.mcp-select\{color-scheme:light\}/.test(uiCss));
ok('body 上的暗色标记把下拉框切到 dark', /body\[data-ds-dark-theme\] \.mcp-select[^{]*\{color-scheme:dark\}/.test(uiCss));
ok('html 上的暗色标记同样覆盖', /html\[data-ds-dark-theme\] \.mcp-select/.test(uiCss));
ok('候选列表用主题背景与文字色', /\.mcp-select option\{background:var\(--dsw-alias-bg-layer-2/.test(uiCss));
ok('候选列表在暗色下有独立背景', /body\[data-ds-dark-theme\] \.mcp-select option[^{]*\{background:/.test(uiCss));
ok('弹层投影分主题', /body\[data-ds-dark-theme\] \.mcp-modal[^{]*\{box-shadow/.test(uiCss));
ok('placeholder 走三级文字色', /\.mcp-input::placeholder,\.mcp-textarea::placeholder\{color:var\(--dsw-alias-label-tertiary\)\}/.test(uiCss));
ok('没有漏拼的模板占位', !/\$\{/.test(uiCss));

// 按钮尺寸、圆角、边框照外壳设置页的规则，hover 走 alias token 而不是 filter。
ok('按钮边框是 .5px 且圆角走 radius-md', /\.mcp-btn\{[^}]*border:\.5px solid transparent[^}]*border-radius:var\(--dsw-radius-md\)/.test(uiCss));
ok('主按钮用一级文字反色', /\.mcp-btn-primary\{background:var\(--dsw-alias-button-primary-fill\);color:var\(--dsw-alias-label-primary-foreground/.test(uiCss));
ok('主按钮 hover 换 token', /\.mcp-btn-primary:not\(:disabled\):hover\{background:var\(--dsw-alias-button-primary-hover/.test(uiCss));
ok('ghost 文字色是一级而非二级', /\.mcp-btn-ghost\{background:transparent;color:var\(--dsw-alias-label-primary\)/.test(uiCss));
ok('ghost hover 用外壳的 ghost 高亮填充', /\.mcp-btn-ghost:not\(:disabled\):hover\{background:var\(--dsw-alias-button-ghost-active-fill\)/.test(uiCss));
ok('行内小按钮 28px 高', /\.mcp-btn\.mcp-btn-sm\{height:28px/.test(uiCss));
ok('按钮不再用 filter 算 hover', !/\.mcp-btn:hover\{filter/.test(uiCss));
ok('按钮不再写死胶囊圆角', !/border-radius:16px/.test(uiCss));
ok('开关提亮也走 token 而非 filter', !/\.mcp-switch-on:hover\{[^}]*filter/.test(uiCss));

// 内联样式表：卡片、编辑区、输入框的底色与边框对齐外壳。
const st = t.styles;
ok('卡片用 settings-card 描边与底色', /settings-card-stroke/.test(st.card.border) && /settings-card-fill/.test(st.card.background));
ok('卡片圆角走 radius-xl', /--dsw-radius-xl/.test(st.card.borderRadius));
ok('输入框边框是 .5px 的 border-l4', st.input.border === '.5px solid var(--dsw-alias-border-l4)');
ok('输入框底色走 bg-base', /--dsw-alias-bg-base/.test(st.input.background));
ok('文本域边框与输入框一致', st.textarea.border === '.5px solid var(--dsw-alias-border-l4)');
ok('字段标签是 500 字重', st.label.fontWeight === 500);
ok('字段内间距 6', st.field.gap === 6);
ok('编辑区底色走 bg-module-platform', /--dsw-alias-bg-module-platform/.test(st.formBody.background));
ok('标签边框是 .5px', /^\.5px solid/.test(st.tag.border));
ok('说明文字行高 18', st.hint.lineHeight === '18px');
ok('章节说明字号 14', st.intro.fontSize === 14);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exitCode = 1;
else console.log('ALL PASS');
