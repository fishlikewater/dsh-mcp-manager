// dsh-mcp-manager — client half (built bundle, classic script).
//
// 在设置面板注册一个「MCP 服务器」页（settings.section, id: mcp），
// 通过 /api/mcp/servers 与宿主侧管理器通信：列出、新增、编辑、删除
// MCP 服务器配置。改动即时生效（宿主热挂载/卸载实例）。
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API = '/api/mcp/servers';
    var e = React.createElement;

    // ── styles ──────────────────────────────────────────────────────────────
    var S = {
      section: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8 },
      rowName: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      tag: { border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 4, padding: '1px 6px', fontSize: 11, lineHeight: '16px' },
      detail: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      statusLine: { fontSize: 12, lineHeight: '18px', display: 'flex', alignItems: 'center', gap: 6 },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none' },
      actions: { display: 'flex', gap: 8, marginTop: 2, alignItems: 'center' },
      button: { height: 32, padding: '0 14px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: '20px', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' },
      buttonGhost: { height: 32, padding: '0 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13, lineHeight: '20px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l3)' },
      buttonDanger: { height: 32, padding: '0 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13, lineHeight: '20px', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)' },
      label: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: 4 },
      input: { boxSizing: 'border-box', width: '100%', height: 32, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', fontSize: 13 },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 56, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', resize: 'vertical' },
      field: { display: 'flex', flexDirection: 'column', gap: 2 },
    };

    // ── helpers ─────────────────────────────────────────────────────────────
    // 设置面板导航的图标由外壳按 section id 硬编码（models/plugins/agent-presets
    // 有专属图标，其余默认齿轮），没有注册点。这里注入一小段 CSS 覆盖，把本插件
    // 那一行的齿轮换成「链接」图标（IconLinkOutline16 的矢量路径，经 mask 渲染，
    // 颜色跟随导航行的 currentColor）。选择器用 :last-child 定位（本插件的 order
    // 最高、行排最后）；外壳类名哈希随版本变化，失效时只会安静地退回齿轮。
    function injectNavIconCss() {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
        + '<path d="M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z" fill="black"/>'
        + '<path d="M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z" fill="black"/>'
        + '</svg>';
      var mask = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
      var css = '.VOzbGW_navList .VOzbGW_navCell:last-child .VOzbGW_navIcon path{display:none}'
        + '.VOzbGW_navList .VOzbGW_navCell:last-child .VOzbGW_navIcon{width:16px;height:16px;background-color:currentColor;-webkit-mask:' + mask + ' center/16px 16px no-repeat;mask:' + mask + ' center/16px 16px no-repeat}';
      var el = document.createElement('style');
      el.setAttribute('data-plugin', 'dsh-mcp-manager-nav-icon');
      el.textContent = css;
      document.head.appendChild(el);
      return el;
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

    // 把表单状态组装成与宿主侧约定一致的服务器对象（见 lib/logic.js 的
    // validateServers）。与宿主校验一一对应，测试里做「客户端产出 →
    // 宿主校验」的往返兼容断言。
    function buildServerObject(f, initial) {
      return {
        serverName: f.serverName.trim(),
        enabled: initial.enabled !== false,
        transport: f.transport,
        command: f.command,
        args: parseLines(f.args),
        env: parseEnv(f.env),
        cwd: f.cwd.trim(),
        url: f.url.trim(),
        headers: parseHeaders(f.headers),
        toolCallTimeoutMs: Number(f.toolCallTimeoutMs),
        failOnStartupError: f.failOnStartupError === true || f.failOnStartupError === 'true',
      };
    }

    function loadServers() {
      return fetch(API, { method: 'GET' }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          return data;
        });
      });
    }

    // rev 是宿主返回的修订号（乐观锁）：提交时带回，若配置已被其他窗口
    // 改过，宿主返回 409（code: conflict），由调用方刷新并提示。
    function saveServers(servers, rev) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: rev, servers: servers }),
      }).then(function (res) {
        return res.json().then(function (data) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = data.code;
          err.rev = data.rev;
          if (!res.ok) throw err;
          return data;
        });
      });
    }

    // ── 导航图标自检 ────────────────────────────────────────────────────────
    // 图标覆盖依赖外壳的类名哈希（VOzbGW_*），DSH 升级后可能静默失效。
    // 在设置页真正渲染时检查一次：导航列表存在而目标图标选择器未命中，
    // 说明外壳结构已变 → 打一条警告（功能不受影响，只是退回默认齿轮图标）。
    function inspectNavIcon() {
      try {
        var navList = document.querySelector('.VOzbGW_navList');
        if (!navList) return; // 外壳导航还没渲染：不判断，避免误报
        var hit = document.querySelector('.VOzbGW_navList .VOzbGW_navCell:last-child .VOzbGW_navIcon');
        if (hit) return;
        console.warn('[dsh-mcp-manager] 设置页导航图标覆盖未命中：DSH 外壳类名（.VOzbGW_*）可能已变化，已退回默认图标（功能不受影响）');
      } catch (error) { /* 自检失败不影响功能 */ }
    }

    // ── components ──────────────────────────────────────────────────────────
    function ServerRow(props) {
      var server = props.server;
      var status = props.status;
      var busy = props.toggling;
      var enabled = server.enabled !== false;
      var state = status && status.state;
      var transport = server.transport === 'streamable-http' ? 'HTTP' : 'stdio';
      var detail = server.transport === 'streamable-http'
        ? server.url
        : (server.command || '') + (server.args && server.args.length ? ' ' + server.args.join(' ') : '');
      var dotStyle = Object.assign({}, S.dot, {
        background: state === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : state === 'disabled'
            ? 'var(--dsw-alias-label-disabled, var(--dsw-alias-label-tertiary))'
            : 'var(--dsw-alias-state-success-primary)',
      });
      var statusText = state === 'error' ? '错误' : state === 'disabled' ? '已关闭' : '已挂载';
      return e('div', { style: S.card },
        e('div', { style: S.rowHead },
          e('span', { style: S.rowName }, server.serverName),
          e('span', { style: S.tag }, transport),
          e('span', { style: Object.assign({}, S.statusLine, { marginLeft: 'auto' }) },
            e('span', { style: dotStyle }),
            statusText,
          ),
        ),
        e('div', { style: S.detail }, detail),
        status && status.state === 'error'
          ? e('p', { style: S.error }, status.message)
          : null,
        e('div', { style: S.actions },
          e('button', {
            style: enabled ? S.buttonGhost : S.button,
            disabled: busy,
            onClick: function () { props.onToggle(server); },
          }, busy ? (enabled ? '关闭中…' : '开启中…') : (enabled ? '关闭' : '开启')),
          e('button', { style: S.buttonGhost, disabled: busy, onClick: function () { props.onEdit(server); } }, '编辑'),
          e('button', { style: S.buttonDanger, disabled: busy, onClick: function () { props.onDelete(server); } }, '删除'),
        ),
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
        toolCallTimeoutMs: String(initial.toolCallTimeoutMs || 60000),
        failOnStartupError: String(initial.failOnStartupError === true),
      });
      var f = holder[0];
      var setF = holder[1];
      var set = function (key) {
        return function (ev) {
          var next = Object.assign({}, f);
          next[key] = ev.target.value;
          setF(next);
        };
      };

      return e('div', { style: S.card },
        e('div', { style: S.field },
          e('span', { style: S.label }, '名称（serverName）'),
          e('input', { style: S.input, value: f.serverName, placeholder: '如 github / mydb；工具名将是 mcp__<名称>__<工具名>', onChange: set('serverName') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '传输方式'),
          e('select', { style: S.input, value: f.transport, onChange: set('transport') },
            e('option', { value: 'stdio' }, 'stdio（本地命令）'),
            e('option', { value: 'streamable-http' }, 'streamable-http（远程 URL）'),
          ),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '命令（command）'),
          e('input', { style: S.input, value: f.command, placeholder: '如 npx，或可执行文件绝对路径', onChange: set('command') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '参数（args，每行一个）'),
          e('textarea', { style: S.textarea, value: f.args, onChange: set('args') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '环境变量（env，每行 KEY=VALUE）'),
          e('textarea', { style: S.textarea, value: f.env, onChange: set('env') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '工作目录（cwd，可选）'),
          e('input', { style: S.input, value: f.cwd, onChange: set('cwd') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, 'URL（streamable-http）'),
          e('input', { style: S.input, value: f.url, placeholder: 'http://localhost:3000/mcp', onChange: set('url') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '请求头（headers，每行 KEY: VALUE）'),
          e('textarea', { style: S.textarea, value: f.headers, onChange: set('headers') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '工具调用超时（toolCallTimeoutMs，毫秒）'),
          e('input', { style: S.input, type: 'number', min: 1, value: f.toolCallTimeoutMs, onChange: set('toolCallTimeoutMs') }),
        ),
        e('div', { style: S.field },
          e('span', { style: S.label }, '启动失败即报错（failOnStartupError）'),
          e('select', { style: S.input, value: f.failOnStartupError, onChange: set('failOnStartupError') },
            e('option', { value: 'false' }, '否（连接失败自动重连）'),
            e('option', { value: 'true' }, '是（首次连接/工具同步失败时报错）'),
          ),
        ),
        props.error ? e('p', { style: S.error }, props.error) : null,
        e('div', { style: S.actions },
          e('button', {
            style: S.button,
            disabled: props.saving,
            onClick: function () {
              var server = buildServerObject(f, initial);
              if (!server.serverName) return props.onError('名称不能为空');
              if (f.transport === 'stdio' && !server.command.trim()) return props.onError('stdio 传输必须填写命令');
              if (f.transport === 'streamable-http' && !server.url) return props.onError('streamable-http 必须填写 URL');
              if (!f.toolCallTimeoutMs || !(Number(f.toolCallTimeoutMs) >= 1)) return props.onError('超时必须是 >= 1 的数字（毫秒）');
              props.onSave(server);
            },
          }, props.saving ? '保存中…' : '保存'),
          e('button', { style: S.buttonGhost, onClick: props.onCancel }, '取消'),
        ),
      );
    }

    function McpSection() {
      var holder = useState({ servers: [], status: {}, rev: 0, loading: true, error: '', editing: null, saving: false, formError: '', notice: '', toggling: null });
      var data = holder[0];
      var setData = holder[1];

      var patch = function (part) {
        setData(function (prev) { return Object.assign({}, prev, part); });
      };

      var load = function () {
        loadServers().then(function (d) {
          patch({ rev: d.rev || 0, servers: d.servers || [], status: d.status || {}, loading: false, error: '' });
        }).catch(function (err) {
          patch({ loading: false, error: String(err && err.message || err) });
        });
      };

      useEffect(load, []);

      // 乐观锁冲突（409）：别的窗口/页面改过配置，刷新后再让用户确认。
      var onConflict = function () {
        patch({ notice: '配置已被其他窗口/页面修改，已刷新，请核对后再保存', error: '', formError: '' });
        load();
      };

      var save = function (server) {
        var next;
        if (data.editing === 'new') {
          next = data.servers.concat([server]);
        } else {
          var target = data.editing && data.editing.serverName;
          next = data.servers.map(function (s) { return s.serverName === target ? server : s; });
        }
        patch({ saving: true, formError: '' });
        saveServers(next, data.rev).then(function () {
          patch({ saving: false, editing: null, notice: '已保存并生效' });
          load();
        }).catch(function (err) {
          if (err && err.code === 'conflict') { patch({ saving: false, formError: '' }); onConflict(); return; }
          patch({ saving: false, formError: String(err && err.message || err) });
        });
      };

      var remove = function (server) {
        if (!window.confirm('删除 MCP 服务器 ' + server.serverName + '？相关工具会立即移除。')) return;
        var next = data.servers.filter(function (s) { return s.serverName !== server.serverName; });
        saveServers(next, data.rev).then(function () {
          patch({ notice: '已删除 ' + server.serverName });
          load();
        }).catch(function (err) {
          if (err && err.code === 'conflict') { onConflict(); return; }
          patch({ error: String(err && err.message || err) });
        });
      };

      // 开启/关闭某台服务器：只翻转它的 enabled，其余配置原样提交。
      var toggle = function (server) {
        var enabling = server.enabled === false;
        var next = data.servers.map(function (s) {
          return s.serverName === server.serverName ? Object.assign({}, s, { enabled: enabling }) : s;
        });
        patch({ toggling: server.serverName, error: '', notice: '' });
        saveServers(next, data.rev).then(function () {
          patch({ toggling: null, notice: (enabling ? '已开启 ' : '已关闭 ') + server.serverName });
          load();
        }).catch(function (err) {
          patch({ toggling: null });
          if (err && err.code === 'conflict') { onConflict(); return; }
          patch({ error: String(err && err.message || err) });
        });
      };

      var cards = data.servers.map(function (server) {
        return e(ServerRow, {
          key: server.serverName,
          server: server,
          status: data.status[server.serverName],
          toggling: data.toggling === server.serverName,
          onToggle: toggle,
          onEdit: function (s) { patch({ editing: s, formError: '' }); },
          onDelete: remove,
        });
      });

      return e('div', { style: S.section },
        e('h2', { style: S.title }, 'MCP 服务器'),
        e('p', { style: S.intro }, '在这里配置给我用的 MCP 服务器（Model Context Protocol）。保存后立即生效，每台服务器可单独「开启/关闭」：我会拿到 mcp__<名称>__<工具名> 形式的工具。'),
        data.error ? e('p', { style: S.error }, data.error) : null,
        data.notice ? e('p', { style: S.ok }, data.notice) : null,
        cards.length
          ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, cards)
          : (data.loading ? null : e('p', { style: S.intro }, '还没有配置任何 MCP 服务器。')),
        data.editing
          ? e(ServerForm, {
              key: data.editing === 'new' ? 'new' : data.editing.serverName,
              initial: data.editing === 'new' ? null : data.editing,
              saving: data.saving,
              error: data.formError,
              onSave: save,
              onError: function (msg) { patch({ formError: msg }); },
              onCancel: function () { patch({ editing: null, formError: '' }); },
            })
          : e('button', { style: S.button, onClick: function () { patch({ editing: 'new', formError: '' }); } }, '＋ 添加服务器'),
        e('div', { style: S.actions },
          e('button', { style: S.buttonGhost, onClick: load }, '刷新'),
        ),
      );
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    var inject = ['slots'];
    // 包装一层：设置页真正渲染时做一次导航图标覆盖的自检（外壳类名哈希
    // 变更时打警告，功能不受影响）。
    function IconCheckedSection(props) {
      useEffect(inspectNavIcon, []);
      return e(McpSection, props);
    }
    function apply(ctx) {
      var navIconStyle = injectNavIconCss();
      ctx.effect(function () { return function () { navIconStyle.remove(); }; });
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'mcp',
          order: 30,
          label: function () { return 'MCP 服务器'; },
        }, IconCheckedSection);
      });
    }
    // 导出解析/组装助手：浏览器加载器只消费 apply/inject，多出的导出仅用于
    // node:test 对客户端逻辑做兼容性测试（test/client-logic.test.js）。
    exports.apply = apply;
    exports.inject = inject;
    exports.parseLines = parseLines;
    exports.parseEnv = parseEnv;
    exports.parseHeaders = parseHeaders;
    exports.joinEntries = joinEntries;
    exports.buildServerObject = buildServerObject;
    exports.inspectNavIcon = inspectNavIcon;
    return module.exports;
  },
});
