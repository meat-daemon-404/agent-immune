/**
 * The dashboard page, as one self-contained string.
 *
 * No external CSS/JS: this must work offline and must not phone anywhere. The
 * runtime token is substituted in so the page can call the local API, and the
 * embedded script uses string concatenation rather than template literals so
 * nothing inside it can be mistaken for an interpolation.
 *
 * The marker (brand glyph, status dots, skeleton) is pure CSS — an inline <svg>
 * would drag an `xmlns="http://…"` through the document and the offline test
 * (no `http(s)://` anywhere) is right to reject that.
 */

export interface PageOptions {
  token: string;
  /** Display language for labels. */
  locale: 'zh-CN' | 'en';
  /** Shown in the header so it is obvious which database is open. */
  dbPath: string;
  /** Effective turn-end distillation budget, for the KPI card. */
  budgetMs?: number;
}

/** Every label the page uses, in both the HTML and the embedded script. */
interface Labels {
  title: string;
  subtitle: string;
  search: string;
  clear: string;
  tabsProject: string;
  tabsShared: string;
  intercepted: string;
  storage: string;
  modelRules: string;
  exportLabel: string;
  importLabel: string;
  toastImported: string;
  repairedBy: string;
  sort: string;
  sortRecent: string;
  sortHits: string;
  sortFails: string;
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
  emptyHint: string;
  noShared: string;
  noSharedHint: string;
  activeCount: string;
  retiredCount: string;
  injections: string;
  sharedCount: string;
  budget: string;
  budgetHint: string;
  localOnly: string;
  confirmRemove: string;
  loading: string;
  loadFailed: string;
  results: string;
  browseNote: string;
  toastRetired: string;
  toastRestored: string;
  toastDeleted: string;
}

const LABELS: Record<'zh-CN' | 'en', Labels> = {
  'zh-CN': {
    title: '免疫系统',
    subtitle: '本项目的避坑抗体',
    search: '搜索触发词、症状或处方…',
    clear: '清除',
    tabsProject: '项目库',
    tabsShared: '共享库',
    sort: '排序',
    sortRecent: '最近更新',
    sortHits: '命中最多',
    sortFails: '失效最多',
    colTrigger: '触发',
    colAvoid: '忌',
    colDo: '宜',
    colStats: '命中 / 失效',
    colStatus: '状态',
    colActions: '操作',
    retire: '退役',
    restore: '恢复',
    remove: '删除',
    active: '生效',
    retired: '已退役',
    empty: '还没有抗体',
    emptyHint: '工具先失败、随后用另一种方式成功之后，这里才会长出一条。',
    noShared: '共享库为空',
    noSharedHint: '泛型坑在多个项目反复命中后才会晋升到这里。',
    activeCount: '生效',
    retiredCount: '已退役',
    injections: '累计注入',
    sharedCount: '共享库',
    budget: '蒸馏预算',
    budgetHint: '回合末可用的时间预算（IMMUNE_DISTILL_BUDGET_MS）',
    intercepted: '拦截',
    storage: '库大小',
    modelRules: '模型产出',
    exportLabel: '导出',
    importLabel: '导入',
    toastImported: '已导入',
    repairedBy: '修复动作: ',
    localOnly: '仅本机可访问',
    confirmRemove: '删除后不可恢复，确定？',
    loading: '加载中…',
    loadFailed: '加载失败',
    results: '条结果',
    browseNote: '浏览不计入命中数——只有真正注入给模型才算一次命中。',
    toastRetired: '已退役',
    toastRestored: '已恢复',
    toastDeleted: '已删除',
  },
  en: {
    title: 'Immune System',
    subtitle: 'Pitfall antibodies for this project',
    search: 'Search trigger, symptom or prescription…',
    clear: 'Clear',
    tabsProject: 'Project',
    tabsShared: 'Shared',
    sort: 'Sort',
    sortRecent: 'Recently updated',
    sortHits: 'Most hits',
    sortFails: 'Most failures',
    colTrigger: 'Trigger',
    colAvoid: 'Avoid',
    colDo: 'Do instead',
    colStats: 'Hits / fails',
    colStatus: 'Status',
    colActions: 'Actions',
    retire: 'Retire',
    restore: 'Restore',
    remove: 'Delete',
    active: 'active',
    retired: 'retired',
    empty: 'No antibodies yet',
    emptyHint: 'They appear after a tool fails and then succeeds another way.',
    noShared: 'The shared library is empty',
    noSharedHint: 'Generic pitfalls are promoted here after repeated hits across projects.',
    activeCount: 'active',
    retiredCount: 'retired',
    injections: 'injections',
    sharedCount: 'shared',
    budget: 'distill budget',
    budgetHint: 'Time budget available at turn end (IMMUNE_DISTILL_BUDGET_MS)',
    intercepted: 'intercepted',
    storage: 'storage',
    modelRules: 'from model',
    exportLabel: 'export',
    importLabel: 'import',
    toastImported: 'imported',
    repairedBy: 'repaired by: ',
    localOnly: 'local only',
    confirmRemove: 'Deletion is permanent. Continue?',
    loading: 'Loading…',
    loadFailed: 'Load failed',
    results: 'results',
    browseNote: 'Browsing does not count as injection — only delivery to the model does.',
    toastRetired: 'retired',
    toastRestored: 'restored',
    toastDeleted: 'deleted',
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

/** "12.5 s" / "800 ms" — the budget is a duration, not a raw number, in the UI. */
function formatBudget(ms: number): string {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

export function renderPage(options: PageOptions): string {
  const t = LABELS[options.locale];
  const labelsJson = JSON.stringify(t).replace(/</g, '\\u003c');
  const budget = formatBudget(options.budgetMs ?? 12_000);

  return `<!doctype html>
<html lang="${options.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<title>${esc(t.title)}</title>
<style>
  :root {
    --bg: #0d1016; --bg-soft: #121722; --panel: #161c27; --panel-2: #1b2331;
    --line: #242e3d; --line-soft: #1e2634;
    --text: #e8edf5; --muted: #94a1b5; --faint: #6c7a8e;
    --accent: #4f9cf9; --accent-soft: rgba(79,156,249,.13);
    --ok: #37c98a; --ok-soft: rgba(55,201,138,.13);
    --warn: #e3a53f; --bad: #e56565; --bad-soft: rgba(229,101,101,.12);
    --radius: 12px; --radius-sm: 8px;
    --shadow: 0 1px 0 rgba(255,255,255,.03), 0 10px 28px -18px rgba(0,0,0,.75);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f7fa; --bg-soft: #ffffff; --panel: #ffffff; --panel-2: #f1f4f9;
      --line: #e2e7ef; --line-soft: #edf1f6;
      --text: #1a2331; --muted: #5c6878; --faint: #8a94a4;
      --accent: #2f7cf0; --accent-soft: rgba(47,124,240,.10);
      --ok: #12915f; --ok-soft: rgba(18,145,95,.10);
      --warn: #a86a12; --bad: #c23b3b; --bad-soft: rgba(194,59,59,.09);
      --shadow: 0 1px 2px rgba(16,24,40,.05), 0 10px 24px -20px rgba(16,24,40,.35);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background:
      radial-gradient(1100px 500px at 12% -10%, var(--accent-soft), transparent 60%),
      var(--bg);
    color: var(--text);
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, "Noto Sans SC", "PingFang SC", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 26px 22px 44px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

  /* ---------- header ---------- */
  .top { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
  .mark {
    width: 40px; height: 40px; border-radius: 11px; flex: none;
    background: linear-gradient(150deg, var(--accent), #7a5cf0 85%);
    position: relative; box-shadow: 0 6px 18px -8px rgba(79,156,249,.8);
  }
  .mark::before {
    content: ""; position: absolute; inset: 9px; border-radius: 6px 6px 10px 10px;
    background: rgba(255,255,255,.92);
    clip-path: polygon(50% 0%, 100% 18%, 100% 58%, 50% 100%, 0 58%, 0 18%);
  }
  .mark::after {
    content: ""; position: absolute; left: 50%; top: 20px; width: 9px; height: 2px; margin-left: -4.5px;
    background: var(--accent); border-radius: 2px; box-shadow: 0 4px 0 var(--accent);
  }
  .titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  h1 { margin: 0; font-size: 19px; letter-spacing: .2px; font-weight: 650; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .meta { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
    color: var(--muted); font-size: 11.5px; max-width: 46ch; min-width: 0;
  }
  .chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
  .chip code { color: var(--text); font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---------- KPI cards ---------- */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(152px, 1fr)); gap: 12px; margin-top: 18px; }
  .kpi {
    position: relative; background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 13px 15px 12px; box-shadow: var(--shadow);
    overflow: hidden;
  }
  .kpi::after {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--line);
  }
  .kpi[data-tone="ok"]::after { background: var(--ok); }
  .kpi[data-tone="warn"]::after { background: var(--warn); }
  .kpi[data-tone="accent"]::after { background: var(--accent); }
  .kpi .v { font-size: 23px; font-weight: 660; letter-spacing: -.2px; font-variant-numeric: tabular-nums; }
  .kpi .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
  .kpi .hint { color: var(--faint); font-size: 10.5px; margin-top: 1px; }

  /* ---------- toolbar ---------- */
  .toolbar {
    margin-top: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 10px 12px; box-shadow: var(--shadow);
  }
  .search { position: relative; flex: 1 1 300px; min-width: 200px; display: flex; align-items: center; }
  .search .glass {
    position: absolute; left: 11px; width: 13px; height: 13px; border: 2px solid var(--faint);
    border-radius: 50%; pointer-events: none;
  }
  .search .glass::after {
    content: ""; position: absolute; right: -4px; bottom: -3px; width: 6px; height: 2px;
    background: var(--faint); transform: rotate(45deg); border-radius: 2px;
  }
  input[type=search] {
    width: 100%; padding: 9px 34px 9px 32px; font-size: 13.5px; color: var(--text);
    background: var(--bg-soft); border: 1px solid var(--line); border-radius: var(--radius-sm);
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=search]::placeholder { color: var(--faint); }
  input[type=search]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .clear {
    position: absolute; right: 6px; width: 22px; height: 22px; border: 0; border-radius: 6px;
    background: transparent; color: var(--faint); cursor: pointer; font-size: 15px; line-height: 1;
    display: none;
  }
  .clear:hover { background: var(--panel-2); color: var(--text); }
  .clear.show { display: block; }

  .seg { display: inline-flex; background: var(--bg-soft); border: 1px solid var(--line); border-radius: 999px; padding: 2px; }
  .seg button {
    border: 0; background: transparent; color: var(--muted); cursor: pointer;
    padding: 6px 13px; border-radius: 999px; font-size: 12.5px; font-variant-numeric: tabular-nums;
    transition: background .15s, color .15s;
  }
  .seg button.on { background: var(--panel-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
  .seg button b { font-weight: 600; margin-left: 5px; color: var(--faint); }
  .seg button.on b { color: var(--accent); }

  .select { position: relative; }
  .select select {
    appearance: none; padding: 7px 28px 7px 11px; border-radius: var(--radius-sm);
    border: 1px solid var(--line); background: var(--bg-soft); color: var(--text); font-size: 12.5px; cursor: pointer;
  }
  .select::after {
    content: ""; position: absolute; right: 11px; top: 50%; width: 6px; height: 6px; margin-top: -5px;
    border-right: 1.5px solid var(--faint); border-bottom: 1.5px solid var(--faint);
    transform: rotate(45deg); pointer-events: none;
  }

  /* ---------- table ---------- */
  .panel { margin-top: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .meta-row { display: flex; justify-content: space-between; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line-soft); color: var(--faint); font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    position: sticky; top: 0; z-index: 1; text-align: left; padding: 9px 14px;
    background: var(--bg-soft); color: var(--muted); font-weight: 550; font-size: 11px;
    text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  tbody td { padding: 11px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: background .12s; }
  tbody tr:hover { background: var(--panel-2); }
  tr.is-retired td { opacity: .62; }
  td.id { color: var(--faint); width: 46px; font-variant-numeric: tabular-nums; }
  td.trigger { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; max-width: 300px; word-break: break-word; color: var(--text); }
  td.text { max-width: 290px; word-break: break-word; color: var(--muted); }
  td.text:last-of-type { color: var(--text); }
  .counts { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--faint); }
  .counts b { color: var(--ok); font-weight: 600; }
  .counts .f { color: var(--bad); font-weight: 600; }
  .counts .sep { margin: 0 3px; opacity: .5; }

  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px;
    font-size: 11.5px; white-space: nowrap;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.active { color: var(--ok); background: var(--ok-soft); }
  .pill.retired { color: var(--muted); background: rgba(148,161,181,.12); }

  .repair { margin-top: 3px; font-size: 11px; color: var(--faint); }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; }
  button.act, a.act, label.act {
    border: 1px solid var(--line); background: transparent; color: var(--muted);
    border-radius: 7px; padding: 4px 10px; cursor: pointer; font-size: 12px; transition: all .12s;
    text-decoration: none; display: inline-flex; align-items: center; user-select: none;
  }
  button.act:hover, a.act:hover, label.act:hover { color: var(--text); border-color: var(--muted); background: var(--panel-2); }
  button.act.danger:hover { color: var(--bad); border-color: var(--bad); background: var(--bad-soft); }
  button.act:disabled { opacity: .45; cursor: progress; }

  /* ---------- empty / skeleton ---------- */
  .empty { padding: 46px 20px 52px; text-align: center; }
  .empty .glyph {
    width: 46px; height: 46px; margin: 0 auto 12px; border-radius: 12px;
    border: 1.5px dashed var(--line); position: relative;
  }
  .empty .glyph::before, .empty .glyph::after {
    content: ""; position: absolute; background: var(--line); border-radius: 2px;
  }
  .empty .glyph::before { left: 13px; right: 13px; top: 20px; height: 2px; }
  .empty .glyph::after { top: 13px; bottom: 13px; left: 21px; width: 2px; }
  .empty .t { font-weight: 600; }
  .empty .h { color: var(--muted); margin-top: 4px; font-size: 12.5px; }
  .skel { padding: 6px 0; }
  .skel .r { height: 38px; border-bottom: 1px solid var(--line-soft); display: flex; align-items: center; gap: 14px; padding: 0 14px; }
  .skel .b { height: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--line-soft), var(--line), var(--line-soft)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
  .skel .b:nth-child(1) { width: 34px; } .skel .b:nth-child(2) { width: 26%; } .skel .b:nth-child(3) { width: 22%; } .skel .b:nth-child(4) { width: 18%; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel .b { animation: none; } }

  footer { color: var(--faint); font-size: 11.5px; padding: 16px 4px 0; word-break: break-all; }
  footer .sep { margin: 0 6px; opacity: .5; }

  #toast {
    position: fixed; right: 18px; bottom: 18px; max-width: 320px;
    background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    padding: 10px 14px; border-radius: var(--radius-sm); box-shadow: var(--shadow);
    color: var(--text); font-size: 12.5px; opacity: 0; transform: translateY(6px);
    transition: opacity .18s, transform .18s; pointer-events: none;
  }
  #toast.show { opacity: 1; transform: none; }
  #toast.bad { border-left-color: var(--bad); }

  /* ---------- narrow screens: rows become cards ---------- */
  @media (max-width: 780px) {
    .wrap { padding: 18px 14px 32px; }
    .meta { margin-left: 0; min-width: 0; width: 100%; }
    .chip { max-width: 100%; }
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    thead { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tbody tr { border-bottom: 1px solid var(--line); padding: 10px 4px; }
    tbody tr:last-child { border-bottom: 0; }
    tbody td { border: 0; padding: 4px 12px; display: flex; gap: 12px; }
    tbody td::before {
      content: attr(data-label); flex: 0 0 84px; color: var(--faint); font-size: 11px;
      text-transform: uppercase; letter-spacing: .05em; padding-top: 2px;
    }
    td.id { width: auto; }
    td.trigger, td.text { max-width: none; }
    .acts { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="mark" aria-hidden="true"></div>
    <div class="titles">
      <h1>${esc(t.title)}</h1>
      <div class="sub">${esc(t.subtitle)}</div>
    </div>
    <div class="meta">
      <span class="chip" title="${esc(options.dbPath)}"><span class="dot"></span>${esc(t.localOnly)}<code>${esc(options.dbPath)}</code></span>
    </div>
  </div>

  <div class="kpis" id="kpis" aria-live="polite"></div>

  <div class="toolbar">
    <div class="search">
      <span class="glass" aria-hidden="true"></span>
      <input id="q" type="search" placeholder="${esc(t.search)}" autocomplete="off" spellcheck="false" aria-label="${esc(t.search)}">
      <button class="clear" id="clear" type="button" title="${esc(t.clear)}" aria-label="${esc(t.clear)}">×</button>
    </div>
    <div class="seg" role="tablist">
      <button role="tab" class="on" id="tabProject" aria-selected="true">${esc(t.tabsProject)}<b id="nProject"></b></button>
      <button role="tab" id="tabShared" aria-selected="false">${esc(t.tabsShared)}<b id="nShared"></b></button>
    </div>
    <label class="select">
      <select id="sort" aria-label="${esc(t.sort)}">
        <option value="recent">${esc(t.sortRecent)}</option>
        <option value="hits">${esc(t.sortHits)}</option>
        <option value="fails">${esc(t.sortFails)}</option>
      </select>
    </label>
    <a class="act" id="exportMd" href="/api/export?format=md&t=${esc(options.token)}" download="immune-library.md">${esc(t.exportLabel)}</a>
    <label class="act" id="importWrap">${esc(t.importLabel)}<input id="importFile" type="file" accept=".json,application/json" style="display:none"></label>
  </div>

  <div class="panel">
    <div class="meta-row"><span id="count"></span><span id="budget"></span></div>
    <div id="body"></div>
  </div>

  <footer>${esc(t.browseNote)}<span class="sep">·</span>${esc(t.localOnly)}</footer>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(options.token)};
  var T = ${labelsJson};
  var BUDGET = ${JSON.stringify(budget)};
  var BUDGET_HINT = ${JSON.stringify(t.budgetHint)};

  var kpisEl = document.getElementById('kpis');
  var bodyEl = document.getElementById('body');
  var countEl = document.getElementById('count');
  var budgetEl = document.getElementById('budget');
  var qEl = document.getElementById('q');
  var clearEl = document.getElementById('clear');
  var sortEl = document.getElementById('sort');
  var toastEl = document.getElementById('toast');
  var tabProject = document.getElementById('tabProject');
  var tabShared = document.getElementById('tabShared');
  var nProject = document.getElementById('nProject');
  var nShared = document.getElementById('nShared');
  var tab = 'project';
  var timer = null;
  var seq = 0;

  function api(path) { return path + (path.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN); }

  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = bad ? 'show bad' : 'show';
    setTimeout(function () { toastEl.className = bad ? 'bad' : ''; }, 1800);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderStats(s) {
    kpisEl.textContent = '';
    var cards = [
      [s.active, T.activeCount, 'ok'],
      [s.retired, T.retiredCount, 'warn'],
      [s.hits, T.injections, 'accent'],
      [s.shared, T.sharedCount, 'plain'],
    ];
    cards.forEach(function (c) {
      var card = el('div', 'kpi');
      if (c[2] !== 'plain') card.setAttribute('data-tone', c[2]);
      card.appendChild(el('div', 'v', String(c[0])));
      card.appendChild(el('div', 'k', c[1]));
      kpisEl.appendChild(card);
    });
    var budgetCard = el('div', 'kpi');
    budgetCard.setAttribute('data-tone', 'plain');
    budgetCard.appendChild(el('div', 'v', BUDGET));
    budgetCard.appendChild(el('div', 'k', T.budget));
    budgetCard.setAttribute('title', BUDGET_HINT);
    kpisEl.appendChild(budgetCard);
    budgetEl.textContent = T.budget + ' ' + BUDGET;
    budgetEl.setAttribute('title', BUDGET_HINT);

    // Value counter + storage footprint: the same facts the DSH tab's footer
    // shows, so the two UIs stay one design (AGENTS.md #14).
    var interceptedCard = el('div', 'kpi');
    interceptedCard.setAttribute('data-tone', 'plain');
    interceptedCard.appendChild(el('div', 'v', String(s.suppressedRepeats || 0)));
    interceptedCard.appendChild(el('div', 'k', T.intercepted));
    kpisEl.appendChild(interceptedCard);

    var storageCard = el('div', 'kpi');
    storageCard.setAttribute('data-tone', 'plain');
    storageCard.appendChild(
      el('div', 'v', s.dbBytes != null ? Math.max(1, Math.round(s.dbBytes / 1024)) + ' KiB' : '—'),
    );
    storageCard.appendChild(el('div', 'k', T.storage));
    storageCard.setAttribute(
      'title',
      s.sessions + ' sessions · ' + s.jobsTotal + ' jobs (' + s.jobsPending + ' queued)',
    );
    kpisEl.appendChild(storageCard);

    // Only when a model actually ran: a zero card for everyone else is noise.
    if ((s.llmDistilled || 0) + (s.llmFallbacks || 0) > 0) {
      var modelCard = el('div', 'kpi');
      modelCard.setAttribute('data-tone', s.llmFallbacks > 0 ? 'warn' : 'plain');
      modelCard.appendChild(el('div', 'v', String(s.llmDistilled || 0)));
      modelCard.appendChild(el('div', 'k', T.modelRules));
      modelCard.setAttribute(
        'title',
        (s.llmDistilled || 0) +
          ' rule(s) from the model · ' +
          (s.llmFallbacks || 0) +
          ' degraded to the rule path',
      );
      kpisEl.appendChild(modelCard);
    }

    nProject.textContent = String(s.active + s.retired);
    nShared.textContent = String(s.shared);
  }

  function sortRows(list) {
    var mode = sortEl.value;
    var copy = list.slice();
    copy.sort(function (a, b) {
      if (mode === 'hits') return (b.hit_count - a.hit_count) || (a.id - b.id);
      if (mode === 'fails') return (b.fail_count - a.fail_count) || (a.id - b.id);
      return String(b.updated_at).localeCompare(String(a.updated_at)) || (b.id - a.id);
    });
    return copy;
  }

  function renderSkeleton() {
    bodyEl.textContent = '';
    var sk = el('div', 'skel');
    for (var i = 0; i < 4; i += 1) {
      var r = el('div', 'r');
      r.appendChild(el('div', 'b'));
      r.appendChild(el('div', 'b'));
      r.appendChild(el('div', 'b'));
      r.appendChild(el('div', 'b'));
      sk.appendChild(r);
    }
    bodyEl.appendChild(sk);
  }

  function cell(label, cls, build) {
    var td = el('td', cls);
    td.setAttribute('data-label', label);
    build(td);
    return td;
  }

  function renderRows(list) {
    bodyEl.textContent = '';
    countEl.textContent = list.length + ' ' + T.results;

    if (list.length === 0) {
      var empty = el('div', 'empty');
      empty.appendChild(el('div', 'glyph'));
      empty.appendChild(el('div', 't', tab === 'shared' ? T.noShared : T.empty));
      empty.appendChild(el('div', 'h', tab === 'shared' ? T.noSharedHint : T.emptyHint));
      bodyEl.appendChild(empty);
      return;
    }

    var table = el('table');
    var thead = el('thead');
    var headRow = el('tr');
    ['#', T.colTrigger, T.colAvoid, T.colDo, T.colStats, T.colStatus, T.colActions].forEach(function (label) {
      headRow.appendChild(el('th', '', label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    sortRows(list).forEach(function (a) {
      var tr = el('tr');
      if (a.status === 'retired') tr.className = 'is-retired';

      tr.appendChild(cell('#', 'id', function (td) { td.textContent = String(a.id); }));
      tr.appendChild(cell(T.colTrigger, 'trigger', function (td) { td.textContent = a.trigger_pattern; }));
      tr.appendChild(cell(T.colAvoid, 'text', function (td) { td.textContent = a.symptom; }));
      tr.appendChild(cell(T.colDo, 'text', function (td) {
        td.textContent = a.prescription;
        // Provenance: how the rule was learned (empty for seeded/old rules).
        var rp = Array.isArray(a.repair_path) ? a.repair_path : [];
        if (rp.length > 0) {
          td.appendChild(el('div', 'repair', T.repairedBy + rp.join(' · ')));
        }
      }));

      tr.appendChild(cell(T.colStats, 'counts', function (td) {
        var good = el('b', '', String(a.hit_count));
        var sep = el('span', 'sep', '/');
        var bad = el('span', 'f', String(a.fail_count));
        td.appendChild(good); td.appendChild(sep); td.appendChild(bad);
      }));

      tr.appendChild(cell(T.colStatus, '', function (td) {
        td.appendChild(el('span', 'pill ' + a.status, a.status === 'active' ? T.active : T.retired));
      }));

      tr.appendChild(cell(T.colActions, '', function (td) {
        if (tab !== 'project') return;
        var acts = el('div', 'acts');

        var toggle = el('button', 'act', a.status === 'active' ? T.retire : T.restore);
        toggle.type = 'button';
        toggle.onclick = function () { send(a.status === 'active' ? 'retire' : 'restore', a.id, toggle); };
        acts.appendChild(toggle);

        var del = el('button', 'act danger', T.remove);
        del.type = 'button';
        del.onclick = function () {
          if (!window.confirm(T.confirmRemove)) return;
          send('delete', a.id, del);
        };
        acts.appendChild(del);
        td.appendChild(acts);
      }));

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    bodyEl.appendChild(table);
  }

  function load() {
    var q = qEl.value.trim();
    var mine = ++seq;
    renderSkeleton();
    var path = tab === 'shared'
      ? '/api/shared'
      : '/api/list' + (q ? '?q=' + encodeURIComponent(q) : '');
    fetch(api(path), { headers: { 'accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        if (mine !== seq) return;
        renderStats(data.stats);
        renderRows(data.antibodies);
      })
      .catch(function (err) {
        if (mine !== seq) return;
        bodyEl.textContent = '';
        var box = el('div', 'empty');
        box.appendChild(el('div', 'glyph'));
        box.appendChild(el('div', 't', T.loadFailed));
        box.appendChild(el('div', 'h', String((err && err.message) || err)));
        bodyEl.appendChild(box);
        toast(T.loadFailed, true);
      });
  }

  function send(op, id, button) {
    if (button) button.disabled = true;
    fetch(api('/api/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: op, id: id }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { toast(data.error, true); return; }
        toast(op === 'delete' ? T.toastDeleted + ' #' + id : op === 'retire' ? T.toastRetired + ' #' + id : T.toastRestored + ' #' + id);
        load();
      })
      .catch(function () { toast(T.loadFailed, true); })
      .then(function () { if (button) button.disabled = false; });
  }

  function syncClear() { clearEl.className = qEl.value ? 'clear show' : 'clear'; }

  qEl.addEventListener('input', function () {
    syncClear();
    clearTimeout(timer);
    timer = setTimeout(load, 220);
  });
  clearEl.addEventListener('click', function () {
    qEl.value = '';
    syncClear();
    load();
    qEl.focus();
  });
  sortEl.addEventListener('change', load);

  // Import: read the snapshot file, POST it, report the merge outcome.
  var importFile = document.getElementById('importFile');
  var importWrap = document.getElementById('importWrap');
  if (importFile && importWrap) {
    importFile.addEventListener('change', function () {
      var file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      importWrap.setAttribute('data-busy', '1');
      var reader = new FileReader();
      reader.onload = function () {
        fetch(api('/api/import'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: String(reader.result || ''),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            importWrap.removeAttribute('data-busy');
            if (data.error) { toast(data.error, true); return; }
            toast(T.toastImported + ' +' + data.added + ' / ~' + data.merged);
            load();
          })
          .catch(function (err) {
            importWrap.removeAttribute('data-busy');
            toast(String((err && err.message) || err), true);
          });
      };
      reader.readAsText(file);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== qEl) { e.preventDefault(); qEl.focus(); }
    if (e.key === 'Escape' && document.activeElement === qEl) { qEl.value = ''; syncClear(); load(); }
  });

  function selectTab(next) {
    tab = next;
    tabProject.className = next === 'project' ? 'on' : '';
    tabShared.className = next === 'shared' ? 'on' : '';
    tabProject.setAttribute('aria-selected', next === 'project' ? 'true' : 'false');
    tabShared.setAttribute('aria-selected', next === 'shared' ? 'true' : 'false');
    load();
  }
  tabProject.onclick = function () { selectTab('project'); };
  tabShared.onclick = function () { selectTab('shared'); };

  syncClear();
  load();
})();
</script>
</body>
</html>`;
}
