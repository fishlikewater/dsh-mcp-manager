// dsh-mcp-manager — client half (built bundle, classic script).
//
// 在设置面板注册一个「MCP 服务器」页（settings.section, id: mcp-manager），
// 通过官方 settings remote（ctx.remote.settings）读写本 Loader 条目
// （id: mcp-manager）的 config.servers：列出、新增、编辑、删除 MCP 服务器。
// 写配置 → 宿主重载该条目 → 按新配置挂载 mcp-client 实例，改动即时生效。
//
// 0.3.1 修正：官方 settings 通道是客户端 Remote 命名空间 ctx.remote.settings
// （inject 需声明 remote 与 remote.settings；0.3.0 误用的 connection.api.settings 并不存在），
// 应答为直接的 { ok: true, value } / { ok: false, error }，写入签名是
// mutate(ns, ops, expectedRevision) 三个位置参数。
//
// 0.3.0 通道迁移（适配 DSH 0.1.7-rc.2 / 桌面版）：
// - 数据层从自建 HTTP 路由（/api/mcp/servers）改为官方 settings remote：
//   ctx.remote.settings.describe() 读，mutate(ns, ops, expectedRevision) 写回，
//   应答为 { ok: true, value } / { ok: false, error: { code, message } }，
//   冲突码是 settings/conflict（带修订栅栏）
// - 设置命名空间就是条目 id（mcp-manager），不再自注册 'mcp' 命名空间
// - 卡片状态改为配置层语义（已开启/已关闭）；运行时连接错误看宿主日志
//
// 0.3 UI 打磨：
// - 表单字段随传输方式显隐；字段级实时校验 + 工具前缀预览
// - 开启/关闭改为 Switch 开关；删除改为卡片内两步确认（不再用 window.confirm）
// - 写操作全局互斥（mutate 是整体替换，防止并发覆盖）
// - 5s 静默轮询保持与宿主同步（外部改 patch 后自动跟上）；成功提示自动消失；状态按配置层语义显示
// - 骨架屏 / 空状态 / hover·focus·active 态 / 错误卡片描边
window.__ModuleLoader__.load({
  id: '@fishlikewater/dsh-mcp-manager',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var ReactDOM = require('react-dom');

    // 宿主为每个 Loader 条目提供同名 settings 命名空间（本条目 id: mcp-manager），
    // 客户端经官方 settings remote 读写它的 config。
    var NS = 'mcp-manager';
    // 客户端 Remote 命名空间，由 apply(ctx) 取 ctx.remote 注入；不可用时保持 null。
    var remote = null;
    var e = React.createElement;
    var NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

    // ── styles ──────────────────────────────────────────────────────────────
    // 颜色/圆角/字体全部走外壳的 --dsw-alias-* 设计变量；hover/focus/动画等
    // 伪类效果无法用 inline style 表达，统一由 injectUiCss() 注入的 .mcp-* 类提供。
    var S = {
      section: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 },
      head: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
      headText: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      rowName: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      rowNameOff: { color: 'var(--dsw-alias-label-tertiary)' },
      tag: { border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 4, padding: '1px 6px', fontSize: 11, lineHeight: '16px', flex: 'none' },
      detail: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      statusLine: { fontSize: 12, lineHeight: '18px', display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flex: 'none' },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none' },
      actions: { display: 'flex', gap: 8, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: 4 },
      field: { display: 'flex', flexDirection: 'column', gap: 2 },
      fieldError: { margin: 0, fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary)' },
      hint: { margin: 0, fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      code: { fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', background: 'rgba(128,128,128,.12)', borderRadius: 4, padding: '1px 5px', fontSize: 11 },
      input: { boxSizing: 'border-box', width: '100%', height: 32, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', fontSize: 13 },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 56, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' },
      empty: { border: '1px dashed var(--dsw-alias-border-l3)', borderRadius: 12, padding: '28px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' },
      formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
    };

    // ── css injection ───────────────────────────────────────────────────────
    // 1) 设置面板导航行没有图标注册点（外壳按 section id 硬编码），
    //    图标自适应注入见下方 installNavIcon()（文本锚定，不依赖外壳类名）。
    // 2) 本插件自身的 .mcp-* 交互样式（按钮 hover/focus、卡片过渡、开关、骨架、状态点、弹层）。
    // 设置面板导航行没有图标注册点：外壳按 section id 硬编码图标。
    // 旧实现依赖外壳 CSS Modules 哈希类名（VOzbGW_*）+ :last-child 定位，
    // 外壳升级（类名哈希变化）或安装更高 order 的设置插件后即失效。
    // 现改为运行时自适应：以本插件注册的 label 文本「MCP 服务器」为锚点，
    // MutationObserver 定位导航行并把链接图标 mask 直接画到行内图标元素上，
    // 不依赖任何外壳类名；找不到时安静退回默认齿轮，不影响功能。
    var NAV_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
        + '<path d="M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z" fill="black"/>'
        + '<path d="M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z" fill="black"/>'
        + '</svg>';
      var NAV_ICON_MASK = 'url("data:image/svg+xml,' + encodeURIComponent(NAV_ICON_SVG) + '")';

    function injectUiCss() {
      var css = ''
        // 按钮
        + '.mcp-btn{height:32px;padding:0 14px;border-radius:16px;border:none;cursor:pointer;font-size:13px;line-height:20px;display:inline-flex;align-items:center;gap:4px;font-family:inherit;transition:filter .12s ease,background-color .12s ease,border-color .12s ease,opacity .12s ease}'
        + '.mcp-btn:hover{filter:brightness(1.08)}'
        + '.mcp-btn:active{filter:brightness(.94)}'
        + '.mcp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,var(--dsw-alias-button-primary-fill));outline-offset:2px}'
        + '.mcp-btn:disabled{opacity:.5;cursor:not-allowed;filter:none}'
        + '.mcp-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}'
        + '.mcp-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)}'
        + '.mcp-btn-danger{background:transparent;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}'
        + '.mcp-btn-danger-solid{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:1px solid var(--dsw-alias-state-error-primary)}'
        // 卡片
        + '.mcp-card{transition:border-color .15s ease}'
        + '.mcp-card:hover{border-color:var(--dsw-alias-border-l3)}'
        + '.mcp-card-error{border-color:var(--dsw-alias-state-error-primary)}'
        // 输入框
        + '.mcp-input:focus,.mcp-textarea:focus{outline:none;border-color:var(--dsw-alias-state-info-primary,var(--dsw-alias-button-primary-fill))}'
        + '.mcp-input-invalid,.mcp-input-invalid:focus{border-color:var(--dsw-alias-state-error-primary)}'
        // 开关
        + '.mcp-switch{position:relative;width:34px;height:18px;border-radius:9px;border:1px solid var(--dsw-alias-border-l3);background:transparent;cursor:pointer;padding:0;box-sizing:border-box;transition:background-color .15s ease,border-color .15s ease;flex:none}'
        + '.mcp-switch:hover{border-color:var(--dsw-alias-label-secondary)}'
        + '.mcp-switch-on{background:var(--dsw-alias-button-primary-fill);border-color:transparent}'
        + '.mcp-switch-on:hover{border-color:transparent;filter:brightness(1.08)}'
        + '.mcp-switch:disabled{opacity:.5;cursor:not-allowed}'
        + '.mcp-switch:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,var(--dsw-alias-button-primary-fill));outline-offset:2px}'
        + '.mcp-switch-thumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .15s ease,background-color .15s ease;pointer-events:none}'
        + '.mcp-switch-on .mcp-switch-thumb{left:18px;background:var(--dsw-alias-label-primary-foreground)}'
        // 骨架 / 状态点
        + '@keyframes mcpShimmer{0%,100%{opacity:.5}50%{opacity:1}}'
        + '.mcp-skeleton div{animation:mcpShimmer 1.3s ease-in-out infinite}'
        + '@keyframes mcpBlink{0%,100%{opacity:1}50%{opacity:.35}}'
        + '.mcp-dot-error{animation:mcpBlink 1.5s ease-in-out infinite}'
        // 弹层（遮罩用外壳的 bg-mask-3 token，面板用 layer-2 浮层背景）
        + '.mcp-modal-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-3);display:flex;padding:24px 16px;overflow-y:auto;z-index:1000;animation:mcpFadeIn .15s ease}'
        // margin:auto —— 面板矮于视口时完全居中；超高时自动贴顶且遮罩可滚动（避免顶部被裁）
        + '.mcp-modal{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.28);width:640px;max-width:100%;padding:20px;margin:auto;animation:mcpSlideUp .18s ease}'
        + '@keyframes mcpFadeIn{from{opacity:0}to{opacity:1}}'
        + '@keyframes mcpSlideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}';
      var el = document.createElement('style');
      el.setAttribute('data-plugin', 'dsh-mcp-manager-ui');
      el.textContent = css;
      document.head.appendChild(el);
      return el;
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    // 导航图标自适应注入：文本锚定 + MutationObserver，不依赖任何外壳类名。
    function installNavIcon() {
      var MARK = 'data-mcp-nav-icon';
      var painted = [];

      function paint(el) {
        el.setAttribute(MARK, '1');
        painted.push(el);
        var mask = NAV_ICON_MASK + ' center/16px 16px no-repeat';
        if (el.tagName === 'svg') {
          el.innerHTML = '';
          el.style.mask = mask;
          el.style.webkitMask = mask;
          el.style.backgroundColor = 'currentColor';
          el.style.width = '16px';
          el.style.height = '16px';
        } else if (el.tagName === 'IMG') {
          el.style.mask = mask;
          el.style.webkitMask = mask;
          el.style.width = '16px';
          el.style.height = '16px';
        } else {
          el.innerHTML = '';
          el.style.mask = mask;
          el.style.webkitMask = mask;
          el.style.backgroundColor = 'currentColor';
          el.style.width = '16px';
          el.style.height = '16px';
        }
      }

      // 行内图标候选：svg > img > 单字符小元素（尺寸受限，防止把 label 文本当图标）。
      function findIcon(row) {
        var svg = row.querySelector('svg');
        if (svg) return svg;
        var img = row.querySelector('img');
        if (img) return img;
        var kids = row.children;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.children.length === 0 && (k.textContent || '').trim().length <= 1
            && k.offsetWidth <= 24 && k.offsetHeight <= 24) return k;
        }
        return null;
      }

      // 找包含「MCP 服务器」文本的导航行：从文本节点逐层向上，
      // 第一个包含图标元素的层即本行（由内向外，不会串到其他行）。
      function findRow() {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            return (node.textContent || '').trim() === 'MCP 服务器'
              ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });
        var text;
        while ((text = walker.nextNode())) {
          var el = text.parentElement;
          for (var depth = 0; el && depth < 8; el = el.parentElement, depth++) {
            var icon = findIcon(el);
            if (icon) { paint(icon); return el; }
          }
        }
        return null;
      }

      var observer = new MutationObserver(function () {
        if (document.visibilityState === 'hidden') return;
        // 导航行被外壳重渲染（data 标记消失）时重新绘制。
        if (!document.querySelector('[' + MARK + ']')) findRow();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      findRow();

      return {
        dispose: function () {
          observer.disconnect();
          painted.forEach(function (el) {
            el.removeAttribute(MARK);
            el.style.mask = '';
            el.style.webkitMask = '';
            el.style.backgroundColor = '';
            el.style.width = '';
            el.style.height = '';
          });
          painted = [];
        },
      };
    }

    function parseLines(text) {
      return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    }

    function parseEnv(text) {
      var out = {};
      parseLines(text).forEach(function (line) {
        var idx = line.indexOf('=');
        if (idx <= 0) return;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      return out;
    }

    function parseHeaders(text) {
      var out = {};
      parseLines(text).forEach(function (line) {
        var eq = line.indexOf('=');
        var colon = line.indexOf(':');
        var idx = eq > 0 && (colon < 0 || eq < colon) ? eq : colon;
        if (idx <= 0) return;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      return out;
    }

    function joinEntries(obj) {
      var out = [];
      Object.keys(obj || {}).forEach(function (k) { out.push(k + '=' + obj[k]); });
      return out.join('\n');
    }

    /** 官方 settings Remote（ctx.remote.settings）；apply() 未拿到时返回 undefined。 */
    function settingsApi() {
      return remote && remote.settings;
    }

    /** 读取本条目命名空间；宿主未注册该 namespace（ns）时返回 null。 */
    function readNamespace() {
      var api = settingsApi();
      if (!api || typeof api.describe !== 'function') {
        return Promise.reject(new Error('settings 通道不可用（ctx.remote.settings 缺失）'));
      }
      return Promise.resolve(api.describe()).then(function (response) {
        if (!response || response.ok !== true) {
          var failure = response && response.error;
          throw new Error((failure && failure.message) || 'settings.describe 失败');
        }
        var value = response.value;
        var namespaces = value && Array.isArray(value.namespaces) ? value.namespaces : [];
        for (var i = 0; i < namespaces.length; i += 1) {
          if (namespaces[i] && namespaces[i].ns === NS) return namespaces[i];
        }
        return null;
      });
    }

    function loadServers() {
      return readNamespace().then(function (namespace) {
        if (!namespace) return { servers: [], status: {}, revision: 0, nsFound: false };
        var value = namespace.value;
        return {
          servers: value && Array.isArray(value.servers) ? value.servers : [],
          // 路线 A 下宿主不再回传实例挂载状态，卡片按配置层 enabled 显示。
          status: {},
          revision: typeof namespace.revision === 'number' ? namespace.revision : 0,
          nsFound: true,
        };
      });
    }

    // 整体替换 servers：数组下标不进 path，避免被解析成对象而使 schema 校验失败。
    // expectedRevision 缺省（undefined）表示无条件写入。
    function saveServers(servers, revision) {
      var api = settingsApi();
      if (!api || typeof api.mutate !== 'function') {
        return Promise.reject(new Error('settings 通道不可用（ctx.remote.settings 缺失）'));
      }
      var ops = [{ op: 'set', path: ['servers'], value: servers }];
      var expected = typeof revision === 'number' && revision > 0 ? revision : void 0;
      return Promise.resolve(api.mutate(NS, ops, expected)).then(function (response) {
        if (!response || response.ok !== true) {
          var failure = response && response.error;
          var code = failure && failure.code;
          throw new Error(((failure && failure.message) || 'settings.mutate 失败')
            + (code === 'settings/conflict' ? '（配置已被其他写入方改动，请刷新后重试）' : ''));
        }
        return response.value;
      });
    }

    // 名称校验：空 / 格式 / 重名（编辑时排除自身）。
    function validateName(name, servers, currentName) {
      if (!name) return '名称不能为空';
      if (!NAME_RE.test(name)) return '1-32 位，仅限字母、数字、下划线、连字符';
      if (servers) {
        var dup = servers.some(function (s) {
          return s.serverName === name && s.serverName !== currentName;
        });
        if (dup) return '已存在同名服务器';
      }
      return '';
    }

    // ── components ──────────────────────────────────────────────────────────
    // 轻量弹层：渲染到 document.body；遮罩点击 / Esc / onClose 关闭。
    function Modal(props) {
      useEffect(function () {
        var onKey = function (ev) { if (ev.key === 'Escape') props.onClose(); };
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, []);
      return ReactDOM.createPortal(
        e('div', {
          className: 'mcp-modal-mask',
          onMouseDown: function (ev) { if (ev.target === ev.currentTarget) props.onClose(); },
        },
          e('div', { className: 'mcp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.label || 'MCP 服务器配置' },
            props.children,
          ),
        ),
        document.body,
      );
    }

    function Button(props) {
      return e('button', {
        type: props.type || 'button',
        className: 'mcp-btn mcp-btn-' + (props.variant || 'ghost'),
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
        style: props.style,
      }, props.children);
    }

    function Switch(props) {
      var on = !!props.checked;
      return e('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': props['aria-label'] || '',
        title: on ? '关闭此服务器：立即卸载实例并移除工具' : '开启此服务器：立即挂载实例并注册工具',
        disabled: props.disabled,
        onClick: props.onChange,
        className: 'mcp-switch' + (on ? ' mcp-switch-on' : ''),
      }, e('span', { className: 'mcp-switch-thumb' }));
    }

    function ServerRow(props) {
      var server = props.server;
      var status = props.status;
      var enabled = server.enabled !== false;
      var state = status && status.state;
      var transport = server.transport === 'streamable-http' ? 'HTTP' : 'stdio';
      var detail = server.transport === 'streamable-http'
        ? server.url
        : (server.command || '') + (server.args && server.args.length ? ' ' + server.args.join(' ') : '');
      // 状态显示的是「配置层」语义：enabled → 已开启 / 已关闭。
      // 实例是否真的连上由宿主日志反映；若宿主将来回传 status.state === 'error'，
      // 这里仍然优先显示错误。
      var dotClass = '';
      var dotColor = 'var(--dsw-alias-state-success-primary)';
      var statusText = enabled ? '已开启' : '已关闭';
      if (state === 'error') {
        dotColor = 'var(--dsw-alias-state-error-primary)';
        dotClass = ' mcp-dot-error';
        statusText = '错误';
      } else if (!enabled) {
        dotColor = 'var(--dsw-alias-label-disabled, var(--dsw-alias-label-tertiary))';
      }
      var busy = props.busy;                 // 全局写锁
      var toggling = props.toggling;         // 本卡开关在途
      var deleting = props.deleting;         // 本卡删除在途
      var confirming = props.confirming;     // 本卡处于删除确认
      return e('div', { className: 'mcp-card' + (state === 'error' ? ' mcp-card-error' : ''), style: S.card },
        e('div', { style: S.rowHead },
          e(Switch, {
            checked: enabled,
            disabled: busy,
            onChange: function () { props.onToggle(server); },
            'aria-label': (enabled ? '关闭 ' : '开启 ') + server.serverName,
          }),
          e('span', { style: enabled ? S.rowName : Object.assign({}, S.rowName, S.rowNameOff) }, server.serverName),
          e('span', { style: S.tag }, transport),
          e('span', { style: S.statusLine },
            e('span', { className: dotClass, style: Object.assign({}, S.dot, { background: dotColor }) }),
            toggling ? '处理中…' : statusText,
          ),
        ),
        e('div', { style: S.detail }, detail),
        status && status.state === 'error'
          ? e('p', { style: S.error }, status.message)
          : null,
        e('div', { style: S.actions },
          e(Button, { variant: 'ghost', disabled: busy, onClick: function () { props.onEdit(server); } }, '编辑'),
          confirming
            ? e(Button, {
                variant: 'danger-solid',
                disabled: busy,
                onClick: function () { props.onConfirmDelete(server); },
              }, deleting ? '删除中…' : '确认删除？')
            : e(Button, {
                variant: 'danger',
                disabled: busy,
                onClick: function () { props.onAskDelete(server); },
              }, deleting ? '删除中…' : '删除'),
          confirming
            ? e(Button, { variant: 'ghost', disabled: busy, onClick: props.onCancelDelete }, '取消')
            : null,
        ),
      );
    }

    function SkeletonCard() {
      return e('div', { className: 'mcp-card mcp-skeleton', style: S.card },
        e('div', { style: { height: 18, width: '36%', borderRadius: 6, background: 'var(--dsw-alias-border-l2)' } }),
        e('div', { style: { height: 12, width: '72%', borderRadius: 6, background: 'var(--dsw-alias-border-l2)' } }),
        e('div', { style: { height: 32, width: 180, borderRadius: 16, background: 'var(--dsw-alias-border-l2)' } }),
      );
    }

    function ServerForm(props) {
      var initial = props.initial || {};
      var holder = useState({
        serverName: initial.serverName || '',
        transport: initial.transport || 'stdio',
        command: initial.command || '',
        args: (initial.args || []).join('\n'),
        env: joinEntries(initial.env || {}),
        cwd: initial.cwd || '',
        url: initial.url || '',
        headers: joinEntries(initial.headers || {}),
      });
      var f = holder[0];
      var setF = holder[1];
      var errHolder = useState({});
      var errors = errHolder[0];
      var setErrors = errHolder[1];
      var currentName = initial.serverName || null;

      var setFieldError = function (key, msg) {
        setErrors(function (prev) {
          var next = Object.assign({}, prev);
          if (msg) next[key] = msg; else delete next[key];
          return next;
        });
      };

      var set = function (key) {
        return function (ev) {
          var next = Object.assign({}, f);
          next[key] = ev.target.value;
          setF(next);
          if (key === 'serverName') {
            setFieldError('serverName', validateName(ev.target.value, props.servers, currentName));
          } else if (key === 'command' || key === 'url') {
            setFieldError(key, '');
          } else if (key === 'transport') {
            setFieldError('command', '');
            setFieldError('url', '');
          }
        };
      };

      var errorOf = function (key) { return errors[key] || ''; };
      var nameErr = errorOf('serverName');
      var nameTrim = f.serverName.trim();
      var nameOk = !!nameTrim && NAME_RE.test(nameTrim) && !nameErr;

      var submit = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var server = {
          serverName: f.serverName.trim(),
          enabled: initial.enabled !== false,
          transport: f.transport,
          command: f.command,
          args: parseLines(f.args),
          env: parseEnv(f.env),
          cwd: f.cwd.trim(),
          url: f.url.trim(),
          headers: parseHeaders(f.headers),
        };
        var errs = {};
        var n = validateName(server.serverName, props.servers, currentName);
        if (n) errs.serverName = n;
        if (server.transport === 'stdio' && !server.command.trim()) errs.command = 'stdio 传输必须填写命令';
        if (server.transport === 'streamable-http' && !server.url) errs.url = 'streamable-http 必须填写 URL';
        if (Object.keys(errs).length) { setErrors(errs); return; }
        props.onSave(server);
      };

      // textarea 里 Ctrl/Cmd+Enter 直接保存。
      var onCtrlEnter = function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
          ev.preventDefault();
          submit(ev);
        }
      };

      var isHttp = f.transport === 'streamable-http';
      var stdioFields = [
        {
          key: 'command', label: '命令（command）',
          control: e('input', {
            id: 'mcp-f-command', className: 'mcp-input' + (errorOf('command') ? ' mcp-input-invalid' : ''),
            style: S.input, value: f.command, placeholder: '如 npx，或可执行文件绝对路径',
            onChange: set('command'),
          }),
        },
        {
          key: 'args', label: '参数（args，每行一个）',
          control: e('textarea', {
            id: 'mcp-f-args', className: 'mcp-textarea',
            style: S.textarea, value: f.args, onChange: set('args'), onKeyDown: onCtrlEnter,
          }),
        },
        {
          key: 'env', label: '环境变量（env，每行 KEY=VALUE；值可写成 env:NAME / cred:NAME）',
          control: e('textarea', {
            id: 'mcp-f-env', className: 'mcp-textarea',
            style: S.textarea, value: f.env, onChange: set('env'), onKeyDown: onCtrlEnter,
          }),
        },
        {
          key: 'cwd', label: '工作目录（cwd，可选）',
          control: e('input', {
            id: 'mcp-f-cwd', className: 'mcp-input',
            style: S.input, value: f.cwd, onChange: set('cwd'),
          }),
        },
      ];
      var httpFields = [
        {
          key: 'url', label: 'URL（streamable-http）',
          control: e('input', {
            id: 'mcp-f-url', className: 'mcp-input' + (errorOf('url') ? ' mcp-input-invalid' : ''),
            style: S.input, value: f.url, placeholder: 'http://localhost:3000/mcp',
            onChange: set('url'),
          }),
        },
        {
          key: 'headers', label: '请求头（headers，每行 KEY: VALUE；值可写成 env:NAME / cred:NAME）',
          control: e('textarea', {
            id: 'mcp-f-headers', className: 'mcp-textarea',
            style: S.textarea, value: f.headers, onChange: set('headers'), onKeyDown: onCtrlEnter,
          }),
        },
      ];
      var fields = isHttp ? httpFields : stdioFields;

      return e('form', { onSubmit: submit, noValidate: true },
        e('div', { style: S.formBody },
          e('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
            e('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              e('span', { style: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } },
                initial.serverName ? '编辑 ' + initial.serverName : '添加服务器'),
              initial.serverName
                ? e('p', { style: S.hint }, '改名会先卸载旧实例，再按新名称重新挂载（工具前缀随之变化）。')
                : null,
            ),
            e(Button, {
              variant: 'ghost',
              title: '关闭',
              'aria-label': '关闭',
              onClick: props.onCancel,
              style: { padding: '0 8px', minWidth: 28, height: 28, borderRadius: 8, flex: 'none' },
            }, '✕'),
          ),
          e('div', { style: S.field },
            e('label', { htmlFor: 'mcp-f-name', style: S.label }, '名称（serverName）'),
            e('input', {
              id: 'mcp-f-name', className: 'mcp-input' + (nameErr ? ' mcp-input-invalid' : ''),
              style: S.input, value: f.serverName, autoFocus: true,
              placeholder: '如 github / mydb；工具名将是 mcp__<名称>__<工具名>',
              onChange: set('serverName'), autoComplete: 'off', spellCheck: false,
            }),
            nameErr
              ? e('p', { style: S.fieldError }, nameErr)
              : nameOk
                ? e('p', { style: S.hint }, '工具前缀：', e('code', { style: S.code }, 'mcp__' + nameTrim + '__<工具名>'))
                : null,
          ),
          e('div', { style: S.field },
            e('label', { htmlFor: 'mcp-f-transport', style: S.label }, '传输方式'),
            e('select', { id: 'mcp-f-transport', className: 'mcp-input', style: S.input, value: f.transport, onChange: set('transport') },
              e('option', { value: 'stdio' }, 'stdio（本地命令）'),
              e('option', { value: 'streamable-http' }, 'streamable-http（远程 URL）'),
            ),
          ),
          fields.map(function (field) {
            return e('div', { key: field.key, style: S.field },
              e('label', { htmlFor: 'mcp-f-' + field.key, style: S.label }, field.label),
              field.control,
              errorOf(field.key)
                ? e('p', { style: S.fieldError }, errorOf(field.key))
                : null,
            );
          }),
          props.error ? e('p', { style: S.error }, props.error) : null,
          e('div', { style: S.actions },
            e(Button, { variant: 'primary', type: 'submit', disabled: props.saving }, props.saving ? '保存中…' : '保存'),
            e(Button, { variant: 'ghost', disabled: props.saving, onClick: props.onCancel }, '取消'),
          ),
        ),
      );
    }

    function McpSection() {
      var holder = useState({
        servers: [], status: {}, revision: 0, nsFound: true, loading: true, loadError: '', actionError: '', notice: '',
        editing: null, saving: false, formError: '', toggling: null, deleting: null, confirming: null,
      });
      var data = holder[0];
      var setData = holder[1];
      var timers = useRef({});

      var patch = function (part) {
        setData(function (prev) { return Object.assign({}, prev, part); });
      };

      // 成功提示：4 秒后自动消失。
      var flash = function (msg) {
        patch({ notice: msg });
        clearTimeout(timers.current.notice);
        timers.current.notice = setTimeout(function () { patch({ notice: '' }); }, 4000);
      };

      var clearTimers = function () {
        Object.keys(timers.current).forEach(function (k) { clearTimeout(timers.current[k]); });
        timers.current = {};
      };

      var load = function (opts) {
        loadServers().then(function (d) {
          patch({
            servers: d.servers || [], status: d.status || {}, revision: d.revision || 0,
            nsFound: d.nsFound !== false, loading: false, loadError: '',
          });
        }).catch(function (err) {
          var msg = String((err && err.message) || err);
          if (opts && opts.silent) return; // 轮询失败静默，不打断当前界面
          patch({ loading: false, loadError: msg });
        });
      };

      useEffect(function () {
        load();
        // 5s 轮询：与宿主保持同步（外部改 cordis.patch.yml、修订号前进等）。
        var t = setInterval(function () {
          if (document.visibilityState !== 'hidden') load({ silent: true });
        }, 5000);
        return function () {
          clearInterval(t);
          clearTimers();
        };
      }, []);

      // 写操作全局互斥：POST 是整体替换接口，任一写请求在途时禁用所有写按钮。
      var busyLock = !!(data.saving || data.toggling || data.deleting);

      var save = function (server) {
        var next;
        if (data.editing === 'new') {
          next = data.servers.concat([server]);
        } else {
          var target = data.editing && data.editing.serverName;
          next = data.servers.map(function (s) { return s.serverName === target ? server : s; });
        }
        patch({ saving: true, formError: '' });
        saveServers(next, data.revision).then(function () {
          patch({ saving: false, editing: null });
          flash('已保存并生效');
          load();
        }).catch(function (err) {
          patch({ saving: false, formError: String((err && err.message) || err) });
        });
      };

      var remove = function (server) {
        patch({ deleting: server.serverName, confirming: null, actionError: '' });
        var next = data.servers.filter(function (s) { return s.serverName !== server.serverName; });
        saveServers(next, data.revision).then(function () {
          patch({ deleting: null });
          flash('已删除 ' + server.serverName);
          load();
        }).catch(function (err) {
          patch({ deleting: null, actionError: String((err && err.message) || err) });
        });
      };

      var toggle = function (server) {
        var enabling = server.enabled === false;
        var next = data.servers.map(function (s) {
          return s.serverName === server.serverName ? Object.assign({}, s, { enabled: enabling }) : s;
        });
        patch({ toggling: server.serverName, confirming: null, actionError: '' });
        saveServers(next, data.revision).then(function () {
          patch({ toggling: null });
          flash((enabling ? '已开启 ' : '已关闭 ') + server.serverName);
          load();
        }).catch(function (err) {
          patch({ toggling: null, actionError: String((err && err.message) || err) });
        });
      };

      // 删除两步确认：3 秒内不确认自动还原；点其他操作时取消。
      var askDelete = function (server) {
        patch({ confirming: server.serverName, actionError: '' });
        clearTimeout(timers.current.confirm);
        timers.current.confirm = setTimeout(function () { patch({ confirming: null }); }, 3000);
      };
      var cancelDelete = function () {
        clearTimeout(timers.current.confirm);
        patch({ confirming: null });
      };

      var startAdd = function () {
        patch({ editing: 'new', formError: '', actionError: '', confirming: null });
      };
      var startEdit = function (server) {
        patch({ editing: server, formError: '', actionError: '', confirming: null });
      };
      var closeForm = function () {
        patch({ editing: null, formError: '', confirming: null });
      };

      var cards = data.servers.map(function (server) {
        return e(ServerRow, {
          key: server.serverName,
          server: server,
          status: data.status[server.serverName],
          busy: busyLock,
          toggling: data.toggling === server.serverName,
          deleting: data.deleting === server.serverName,
          confirming: data.confirming === server.serverName,
          onToggle: toggle,
          onEdit: startEdit,
          onAskDelete: askDelete,
          onConfirmDelete: remove,
          onCancelDelete: cancelDelete,
        });
      });

      var showSkeleton = data.loading && data.servers.length === 0;
      var showEmpty = !data.loading && data.servers.length === 0 && !data.editing;

      return e('div', { style: S.section },
        e('div', { style: S.head },
          e('div', { style: S.headText },
            e('h2', { style: S.title }, 'MCP 服务器'),
            e('p', { style: S.intro }, '在这里配置给我用的 MCP 服务器（Model Context Protocol）。保存后宿主立即按新配置重载，每台服务器可单独「开启/关闭」：连上后我会拿到 mcp__<名称>__<工具名> 形式的工具（连接失败见宿主日志）。'),
          ),
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none' } },
            e(Button, {
              variant: 'ghost',
              disabled: data.loading,
              onClick: function () { patch({ loading: true }); load(); },
            }, data.loading ? '刷新中…' : '刷新'),
            e(Button, { variant: 'primary', onClick: startAdd, disabled: busyLock || !!data.editing }, '＋ 添加服务器'),
          ),
        ),
        data.loadError ? e('p', { style: S.error }, '加载失败：' + data.loadError) : null,
        data.nsFound === false
          ? e('p', { style: S.error }, '没有找到 mcp-manager 配置命名空间：请到「设置 → 插件」确认 @fishlikewater/dsh-mcp-manager 已启用，并检查当前 profile 的 cordis.patch.yml 中该条目 id 是否为 mcp-manager。')
          : null,
        data.actionError ? e('p', { style: S.error }, data.actionError) : null,
        data.notice ? e('p', { style: S.ok }, data.notice) : null,
        showSkeleton
          ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              e(SkeletonCard), e(SkeletonCard), e(SkeletonCard))
          : (cards.length
              ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, cards)
              : null),
        showEmpty
          ? e('div', { style: S.empty },
              e('span', { style: { fontSize: 26, lineHeight: 1 } }, '🔌'),
              e('p', { style: Object.assign({}, S.intro, { margin: 0 }) }, '还没有配置任何 MCP 服务器。'),
              e('p', { style: Object.assign({}, S.intro, { margin: 0 }) }, '点右上角「＋ 添加服务器」；也可以直接编辑当前 profile 的 cordis.patch.yml（mcp-manager 条目的 config.servers）后点刷新。'),
              e(Button, { variant: 'primary', onClick: startAdd, disabled: busyLock }, '＋ 添加服务器'),
            )
          : null,
        data.editing
          ? e(Modal, {
              onClose: closeForm,
              label: data.editing === 'new' ? '添加服务器' : '编辑 ' + data.editing.serverName,
            },
              e(ServerForm, {
                key: data.editing === 'new' ? 'new' : data.editing.serverName,
                initial: data.editing === 'new' ? null : data.editing,
                servers: data.servers,
                saving: data.saving,
                error: data.formError,
                onSave: save,
                onCancel: closeForm,
              }))
          : null,
      );
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    var inject = ['slots', 'remote', 'remote.settings'];
    function apply(ctx) {
      remote = ctx.remote;
      if (!remote || !remote.settings) return;
      var uiStyle = injectUiCss();
      var navIcon = installNavIcon();
      ctx.effect(function () {
        return function () {
          uiStyle.remove();
          navIcon.dispose();
        };
      });
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-manager',
          order: 30,
          label: function () { return 'MCP 服务器'; },
        }, McpSection);
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    // 仅供 test/client.selftest.mjs 使用的测试钩子：绕开 DOM，直接验证 settings 通道。
    exports.__test = {
      setRemote: function (value) { remote = value; },
      readNamespace: readNamespace,
      saveServers: saveServers,
    };
    return module.exports;
  },
});
