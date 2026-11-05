/**
 * The dashboard page, as one self-contained string.
 *
 * No external CSS/JS: this must work offline and must not phone anywhere. The
 * runtime token is substituted in so the page can call the local API, and the
 * embedded script uses string concatenation rather than template literals so
 * nothing inside it can be mistaken for an interpolation.
 */

export interface PageOptions {
  token: string;
  /** Display language for labels. */
  locale: 'zh-CN' | 'en';
  /** Shown in the header so it is obvious which database is open. */
  dbPath: string;
}

/** Every label the page uses, in both the HTML and the embedded script. */
interface Labels {
  title: string;
  subtitle: string;
  search: string;
  tabsProject: string;
  tabsShared: string;
  colTrigger: string;
  colAvoid: string;
  colDo: string;
  colStats: string;
  colStatus: string;
  colActions: string;
  retire: string;
  restore: string;
  remove: string;
  active: string;
  retired: string;
  empty: string;
  activeCount: string;
  retiredCount: string;
  injections: string;
  localOnly: string;
  close: string;
  confirmRemove: string;
  noShared: string;
}

const LABELS: Record<'zh-CN' | 'en', Labels> = {
  'zh-CN': {
    title: '免疫系统',
    subtitle: '本项目的避坑抗体',
    search: '搜索触发词、症状或处方…',
    tabsProject: '项目库',
    tabsShared: '共享库',
    colTrigger: '触发',
    colAvoid: '忌',
    colDo: '宜',
    colStats: '命中/失效',
    colStatus: '状态',
    colActions: '操作',
    retire: '退役',
    restore: '恢复',
    remove: '删除',
    active: '生效',
    retired: '已退役',
    empty: '还没有抗体。工具先失败、随后成功之后才会产生。',
    activeCount: '生效',
    retiredCount: '已退役',
    injections: '累计注入',
    localOnly: '仅本机可访问',
    close: '关闭服务',
    confirmRemove: '删除后不可恢复，确定？',
    noShared: '共享库为空。泛型坑在多次命中后才会晋升。',
  },
  en: {
    title: 'Immune System',
    subtitle: 'Pitfall antibodies for this project',
    search: 'Search trigger, symptom or prescription…',
    tabsProject: 'Project',
    tabsShared: 'Shared',
    colTrigger: 'Trigger',
    colAvoid: 'Avoid',
    colDo: 'Do instead',
    colStats: 'Hits/Fails',
    colStatus: 'Status',
    colActions: 'Actions',
    retire: 'Retire',
    restore: 'Restore',
    remove: 'Delete',
    active: 'active',
    retired: 'retired',
    empty: 'No antibodies yet. They appear after a tool fails and then succeeds.',
    activeCount: 'active',
    retiredCount: 'retired',
    injections: 'injections',
    localOnly: 'local only',
    close: 'Stop server',
    confirmRemove: 'Deletion is permanent. Continue?',
    noShared: 'The shared library is empty. Generic pitfalls are promoted after repeated hits.',
  },
};

/** Escape for interpolation into HTML text/attribute position. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPage(options: PageOptions): string {
  const t = LABELS[options.locale];
  const labelsJson = JSON.stringify(t).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${options.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(t.title)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e9ef;
    --muted: #9aa3b2; --accent: #4f9cf9; --ok: #35c07f; --warn: #e0a03a; --bad: #e05a5a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, "Noto Sans SC", sans-serif;
  }
  header { padding: 20px 24px 0; }
  h1 { margin: 0; font-size: 20px; letter-spacing: .2px; display: inline-block; }
  .sub { color: var(--muted); margin-left: 10px; font-size: 13px; }
  .stats { display: flex; gap: 18px; margin: 14px 0 0; flex-wrap: wrap; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; }
  .stat b { font-size: 18px; margin-right: 6px; }
  .stat span { color: var(--muted); font-size: 12px; }
  .bar { display: flex; gap: 10px; align-items: center; padding: 16px 24px 10px; flex-wrap: wrap; }
  input[type=search] {
    flex: 1 1 280px; min-width: 200px; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 9px; padding: 9px 12px; font-size: 14px;
  }
  input[type=search]:focus { outline: none; border-color: var(--accent); }
  .tab {
    background: transparent; color: var(--muted); border: 1px solid var(--line);
    border-radius: 999px; padding: 7px 14px; cursor: pointer; font-size: 13px;
  }
  .tab.on { color: var(--text); border-color: var(--accent); background: rgba(79,156,249,.12); }
  main { padding: 0 24px 40px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.id { color: var(--muted); width: 44px; }
  td.trigger { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; max-width: 320px; word-break: break-word; }
  td.text { max-width: 300px; word-break: break-word; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; }
  .pill.active { color: var(--ok); background: rgba(53,192,127,.12); }
  .pill.retired { color: var(--muted); background: rgba(154,163,178,.12); }
  .num { font-variant-numeric: tabular-nums; color: var(--muted); }
  .num b { color: var(--text); }
  button.act {
    background: transparent; border: 1px solid var(--line); color: var(--muted);
    border-radius: 7px; padding: 4px 9px; cursor: pointer; font-size: 12px; margin-right: 6px;
  }
  button.act:hover { color: var(--text); border-color: var(--muted); }
  button.act.danger:hover { color: var(--bad); border-color: var(--bad); }
  .empty { color: var(--muted); padding: 26px 4px; }
  footer { color: var(--muted); font-size: 12px; padding: 0 24px 28px; word-break: break-all; }
  #toast {
    position: fixed; right: 18px; bottom: 18px; background: var(--panel);
    border: 1px solid var(--line); border-left: 3px solid var(--accent);
    padding: 10px 14px; border-radius: 8px; opacity: 0; transition: opacity .18s; pointer-events: none;
  }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>${esc(t.title)}</h1><span class="sub">${esc(t.subtitle)}</span>
  <div class="stats" id="stats"></div>
</header>
<div class="bar">
  <input id="q" type="search" placeholder="${esc(t.search)}" autocomplete="off" spellcheck="false">
  <button class="tab on" id="tabProject">${esc(t.tabsProject)}</button>
  <button class="tab" id="tabShared">${esc(t.tabsShared)}</button>
</div>
<main>
  <table>
    <thead><tr>
      <th>#</th><th>${esc(t.colTrigger)}</th><th>${esc(t.colAvoid)}</th><th>${esc(t.colDo)}</th>
      <th>${esc(t.colStats)}</th><th>${esc(t.colStatus)}</th><th>${esc(t.colActions)}</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden></div>
</main>
<footer>${esc(t.localOnly)} · ${esc(options.dbPath)}</footer>
<div id="toast"></div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(options.token)};
  var T = ${labelsJson};
  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty');
  var statsEl = document.getElementById('stats');
  var qEl = document.getElementById('q');
  var toastEl = document.getElementById('toast');
  var tab = 'project';
  var timer = null;

  function api(path) { return path + (path.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN); }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderStats(s) {
    statsEl.textContent = '';
    [[s.active, T.activeCount], [s.retired, T.retiredCount], [s.hits, T.injections], [s.shared, T.tabsShared]]
      .forEach(function (pair) {
        var d = el('div', 'stat');
        d.appendChild(el('b', '', String(pair[0])));
        d.appendChild(el('span', '', pair[1]));
        statsEl.appendChild(d);
      });
  }

  function renderRows(list) {
    rowsEl.textContent = '';
    var empty = list.length === 0;
    emptyEl.hidden = !empty;
    if (empty) emptyEl.textContent = tab === 'shared' ? T.noShared : T.empty;

    list.forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', 'id', String(a.id)));
      tr.appendChild(el('td', 'trigger', a.trigger_pattern));
      tr.appendChild(el('td', 'text', a.symptom));
      tr.appendChild(el('td', 'text', a.prescription));

      var num = el('td', 'num');
      num.appendChild(el('b', '', String(a.hit_count)));
      num.appendChild(document.createTextNode(' / ' + a.fail_count));
      tr.appendChild(num);

      var st = el('td');
      st.appendChild(el('span', 'pill ' + a.status, a.status === 'active' ? T.active : T.retired));
      tr.appendChild(st);

      var actions = el('td');
      if (tab === 'project') {
        var toggle = el('button', 'act', a.status === 'active' ? T.retire : T.restore);
        toggle.onclick = function () {
          send(a.status === 'active' ? 'retire' : 'restore', a.id);
        };
        actions.appendChild(toggle);
        var del = el('button', 'act danger', T.remove);
        del.onclick = function () {
          if (!window.confirm(T.confirmRemove)) return;
          send('delete', a.id);
        };
        actions.appendChild(del);
      }
      tr.appendChild(actions);
      rowsEl.appendChild(tr);
    });
  }

  function load() {
    var q = qEl.value.trim();
    var path = tab === 'shared'
      ? '/api/shared'
      : '/api/list' + (q ? '?q=' + encodeURIComponent(q) : '');
    fetch(api(path), { headers: { 'accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderStats(data.stats);
        renderRows(data.antibodies);
      })
      .catch(function () { toast('load failed'); });
  }

  function send(op, id) {
    fetch(api('/api/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: op, id: id }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { toast(data.error); return; }
        toast(op + ' #' + id);
        load();
      })
      .catch(function () { toast('action failed'); });
  }

  qEl.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });

  document.getElementById('tabProject').onclick = function () {
    tab = 'project';
    this.classList.add('on');
    document.getElementById('tabShared').classList.remove('on');
    load();
  };
  document.getElementById('tabShared').onclick = function () {
    tab = 'shared';
    this.classList.add('on');
    document.getElementById('tabProject').classList.remove('on');
    load();
  };

  load();
})();
</script>
</body>
</html>`;
}
