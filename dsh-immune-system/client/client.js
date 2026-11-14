/**
 * Immune settings tab — the native DSH web UI.
 *
 * Hand-written against the client-module contract
 * (`window.__ModuleLoader__.load({ id, factory })`, `factory(require)` returning
 * `module.exports`) so the plugin needs no bundler: the host serves this file
 * verbatim at `/plugins/<id>/client.js`.
 *
 * Written without JSX for the same reason — `React.createElement` is enough for
 * one tab, and it keeps "build" out of the client entirely.
 *
 * Styling: one injected <style> block (scoped under `.imm`) instead of dozens of
 * inline style objects, so hover states, the responsive card layout and the
 * light/dark tokens are expressible at all. The block is static text this file
 * owns, so there is no interpolation and nothing external.
 *
 * Data comes from the host half's route (`/plugins/dsh-immune-system/api`),
 * registered through `ctx.inject(['webServer'], …)`. Nothing here talks to
 * SQLite directly; the browser never sees a database path or a file handle.
 */
window.__ModuleLoader__.load({
  id: 'dsh-immune-system',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (error) {
      ReactDOM = null;
    }

    var API = '/plugins/dsh-immune-system/api';
    var STYLE_ID = 'dsh-immune-system-style';

    var CSS = [
      '.imm{--i-line:var(--dsh-border,#2c3240);--i-line-soft:var(--dsh-border-subtle,#242a36);',
      '--i-panel:var(--dsh-bg-secondary,#141821);--i-panel2:var(--dsh-bg-tertiary,#1b2231);',
      '--i-text:var(--dsh-text-primary,inherit);--i-muted:var(--dsh-text-secondary,#8b94a3);',
      '--i-faint:var(--dsh-text-tertiary,#6b7789);--i-accent:var(--dsh-accent,#4f9cf9);',
      '--i-ok:#37c98a;--i-warn:#e3a53f;--i-bad:#e56565;',
      'display:flex;flex-direction:column;gap:12px;padding:2px;font-size:13px;color:var(--i-text)}',
      '.imm .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.imm .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}',
      '.imm .kpi{position:relative;background:var(--i-panel);border:1px solid var(--i-line);',
      'border-radius:11px;padding:10px 13px;overflow:hidden}',
      '.imm .kpi::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--i-line)}',
      '.imm .kpi.ok::after{background:var(--i-ok)}.imm .kpi.warn::after{background:var(--i-warn)}',
      '.imm .kpi.accent::after{background:var(--i-accent)}',
      '.imm .kpi .v{font-size:20px;font-weight:650;letter-spacing:-.2px;font-variant-numeric:tabular-nums}',
      '.imm .kpi .k{color:var(--i-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;margin-top:1px}',
      '.imm .evo{background:var(--i-panel);border:1px solid var(--i-line);border-radius:11px;padding:10px 14px}',
      '.imm .evo-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.imm .evo-h b{font-size:12px}',
      '.imm .evo-h span{color:var(--i-muted);font-size:11px}',
      '.imm .evo-bars{display:flex;gap:14px;margin-top:8px}',
      '.imm .evo-col{flex:1;display:flex;align-items:flex-end;gap:5px;height:48px}',
      '.imm .evo-col .b{flex:1;background:var(--i-accent);border-radius:2px 2px 0 0;min-height:2px;opacity:.85}',
      '.imm .evo-col.alt .b{background:var(--i-ok);opacity:.55}',
      '.imm .evo-f{margin-top:8px;color:var(--i-muted);font-size:11px}',
      '.imm .search{position:relative;flex:1 1 260px;min-width:180px;display:flex;align-items:center}',
      '.imm .search input{width:100%;padding:8px 32px 8px 30px;font-size:13px;color:inherit;',
      'background:var(--i-panel);border:1px solid var(--i-line);border-radius:8px;transition:border-color .15s,box-shadow .15s}',
      '.imm .search input:focus{outline:none;border-color:var(--i-accent);box-shadow:0 0 0 3px rgba(79,156,249,.15)}',
      '.imm .search .glass{position:absolute;left:10px;width:12px;height:12px;border:2px solid var(--i-faint);border-radius:50%;pointer-events:none}',
      '.imm .search .glass::after{content:"";position:absolute;right:-4px;bottom:-3px;width:6px;height:2px;background:var(--i-faint);transform:rotate(45deg);border-radius:2px}',
      '.imm .search .x{position:absolute;right:5px;width:22px;height:22px;border:0;border-radius:6px;background:transparent;',
      'color:var(--i-faint);cursor:pointer;font-size:15px;line-height:1;display:none}',
      '.imm .search .x.on{display:block}.imm .search .x:hover{background:var(--i-panel2);color:var(--i-text)}',
      '.imm .seg{display:inline-flex;background:var(--i-panel);border:1px solid var(--i-line);border-radius:999px;padding:2px}',
      '.imm .seg button{border:0;background:transparent;color:var(--i-muted);cursor:pointer;padding:6px 12px;',
      'border-radius:999px;font-size:12.5px;font-variant-numeric:tabular-nums;transition:background .15s,color .15s}',
      '.imm .seg button.on{background:var(--i-panel2);color:var(--i-text);box-shadow:inset 0 0 0 1px var(--i-line)}',
      '.imm .seg button b{font-weight:600;margin-left:5px;color:var(--i-faint)}.imm .seg button.on b{color:var(--i-accent)}',
      '.imm select{appearance:none;padding:7px 26px 7px 10px;border-radius:8px;border:1px solid var(--i-line);',
      'background:var(--i-panel);color:inherit;font-size:12.5px;cursor:pointer}',
      '.imm .panel{background:var(--i-panel);border:1px solid var(--i-line);border-radius:11px;overflow:hidden}',
      '.imm .meta-row{display:flex;justify-content:space-between;gap:10px;padding:8px 13px;border-bottom:1px solid var(--i-line-soft);',
      'color:var(--i-faint);font-size:11.5px}',
      '.imm table{width:100%;border-collapse:collapse}',
      '.imm thead th{position:sticky;top:0;z-index:1;text-align:left;padding:8px 13px;background:var(--i-panel2);',
      'color:var(--i-muted);font-weight:550;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;',
      'border-bottom:1px solid var(--i-line);white-space:nowrap}',
      '.imm tbody td{padding:10px 13px;border-bottom:1px solid var(--i-line-soft);vertical-align:top}',
      '.imm tbody tr:last-child td{border-bottom:0}.imm tbody tr{transition:background .12s}',
      '.imm tbody tr:hover{background:var(--i-panel2)}.imm tr.retired td{opacity:.62}',
      '.imm td.id{color:var(--i-faint);width:44px;font-variant-numeric:tabular-nums}',
      '.imm td.trigger{font-family:ui-monospace,Consolas,monospace;font-size:12px;max-width:280px;word-break:break-word}',
      '.imm td.txt{max-width:270px;word-break:break-word;color:var(--i-muted)}',
      '.imm td.txt.do{color:var(--i-text)}',
      '.imm .counts{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--i-faint)}',
      '.imm .meta-row a,.imm .imm-import{color:var(--i-accent,#4cc2ff);cursor:pointer;text-decoration:none}',
      '.imm .imm-import:hover,.imm .meta-row a:hover{text-decoration:underline}',
      '.imm td.do .repair{margin-top:3px;font-size:11px;opacity:.72}',
      '.imm .counts b{color:var(--i-ok);font-weight:600}.imm .counts .f{color:var(--i-bad);font-weight:600}',
      '.imm .pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11.5px;white-space:nowrap}',
      '.imm .pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.imm .pill.active{color:var(--i-ok);background:rgba(55,201,138,.13)}',
      '.imm .pill.retired{color:var(--i-muted);background:rgba(139,148,163,.13)}',
      '.imm .acts{display:flex;gap:6px;flex-wrap:nowrap}',
      '.imm td.ops{white-space:nowrap}',
      '.imm button.act{border:1px solid var(--i-line);background:transparent;color:var(--i-muted);border-radius:7px;',
      'padding:4px 9px;cursor:pointer;font-size:12px;transition:all .12s}',
      '.imm button.act:hover{color:var(--i-text);border-color:var(--i-muted);background:var(--i-panel2)}',
      '.imm button.act.danger:hover{color:var(--i-bad);border-color:var(--i-bad);background:rgba(229,101,101,.1)}',
      '.imm button.act:disabled{opacity:.45;cursor:progress}',
      '.imm .empty{padding:38px 18px 42px;text-align:center}',
      '.imm .empty .glyph{width:42px;height:42px;margin:0 auto 10px;border-radius:11px;border:1.5px dashed var(--i-line);position:relative}',
      '.imm .empty .glyph::before{content:"";position:absolute;left:12px;right:12px;top:19px;height:2px;background:var(--i-line);border-radius:2px}',
      '.imm .empty .glyph::after{content:"";position:absolute;top:12px;bottom:12px;left:19px;width:2px;background:var(--i-line);border-radius:2px}',
      '.imm .empty .t{font-weight:600}.imm .empty .hd{color:var(--i-muted);margin-top:4px;font-size:12px}',
      '.imm .skel .r{height:36px;border-bottom:1px solid var(--i-line-soft);display:flex;align-items:center;gap:12px;padding:0 13px}',
      '.imm .skel .b{height:9px;border-radius:5px;background:linear-gradient(90deg,var(--i-line-soft),var(--i-line),var(--i-line-soft));',
      'background-size:200% 100%;animation:imm-shimmer 1.2s linear infinite}',
      '.imm .skel .b:nth-child(1){width:30px}.imm .skel .b:nth-child(2){width:26%}',
      '.imm .skel .b:nth-child(3){width:22%}.imm .skel .b:nth-child(4){width:16%}',
      '@keyframes imm-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
      '@media (prefers-reduced-motion:reduce){.imm .skel .b{animation:none}}',
      '.imm .note{font-size:11.5px;color:var(--i-faint)}',
      '.imm .err{color:var(--i-bad)}',
      '@media (max-width:720px){.imm thead{display:none}.imm table,.imm tbody,.imm tr,.imm td{display:block;width:100%}',
      '.imm tbody tr{border-bottom:1px solid var(--i-line);padding:8px 2px}',
      '.imm tbody td{border:0;padding:3px 11px;display:flex;gap:10px}',
      '.imm tbody td::before{content:attr(data-label);flex:0 0 76px;color:var(--i-faint);font-size:10.5px;',
      'text-transform:uppercase;letter-spacing:.05em;padding-top:2px}',
      '.imm td.id{width:auto}.imm td.trigger,.imm td.txt{max-width:none}}',
      // Defensive layout: the settings modal is an unknown host, so nothing here
      // may depend on inherited line-height, block-ness or table display.
      '.imm{line-height:1.45;font-family:inherit}',
      '.imm .kpi .v,.imm .kpi .k{display:block}',
      '.imm table{display:table;table-layout:auto}',
      '.imm thead{display:table-header-group}.imm tbody{display:table-row-group}',
      '.imm tr{display:table-row}.imm th,.imm td{display:table-cell}',
      '.imm select{color:var(--i-text)}',
      '.imm select option{color:var(--i-text);background:var(--i-panel)}',
      '.imm .shield{display:block;width:100%;min-width:0}',
    ].join('');

    function request(path, init) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin' }, init)).then(
        function (r) {
          return r.json().then(function (body) {
            if (!r.ok) throw new Error((body && body.error) || r.status);
            return body;
          });
        },
      );
    }

    function formatBudget(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '—';
      return ms >= 1000 ? (ms / 1000) + ' s' : Math.round(ms) + ' ms';
    }

    function kpi(value, label, tone) {
      return h(
        'div',
        { key: label, className: 'kpi' + (tone ? ' ' + tone : '') },
        h('div', { className: 'v' }, String(value)),
        h('div', { className: 'k' }, label),
      );
    }

    function ImmunePanel() {
      var state = React.useState({ loading: true, error: '', stats: null, evolution: null, rows: [], budgetMs: null });
      var view = React.useState('project');
      var query = React.useState('');
      var order = React.useState('recent');

      var data = state[0];
      var setData = state[1];
      var tab = view[0];
      var setTab = view[1];
      var q = query[0];
      var setQ = query[1];
      var sort = order[0];
      var setSort = order[1];

      var load = React.useCallback(
        function (nextTab, nextQuery) {
          var path =
            '/?view=' +
            encodeURIComponent(nextTab) +
            (nextQuery ? '&q=' + encodeURIComponent(nextQuery) : '');
          setData(function (prev) {
            return Object.assign({}, prev, { loading: true, error: '' });
          });
          request(path)
            .then(function (body) {
              setData({
                loading: false,
                error: '',
                stats: body.stats,
                evolution: body.evolution || null,
                rows: body.antibodies,
                budgetMs: body.budgetMs,
              });
            })
            .catch(function (error) {
              setData({
                loading: false,
                error: String(error.message || error),
                stats: null,
                evolution: null,
                rows: [],
                budgetMs: null,
              });
            });
        },
        [setData],
      );

      React.useEffect(
        function () {
          load(tab, q);
        },
        [load, tab],
      );

      var timer = React.useRef(null);
      function onQuery(value) {
        setQ(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          load(tab, value);
        }, 220);
      }

      function act(op, id) {
        if (op === 'delete' && !window.confirm('删除后不可恢复，确定？ / Delete is permanent. Continue?')) {
          return;
        }
        request('/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: op, id: id }),
        })
          .then(function () {
            load(tab, q);
          })
          .catch(function (error) {
            window.alert(String(error.message || error));
          });
      }

      var sync = React.useState('');
      var syncMsg = sync[0];
      var setSyncMsg = sync[1];

      function doImport(event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          setSyncMsg('导入中 / importing…');
          request('/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: String(reader.result || ''),
          })
            .then(function (body) {
              setSyncMsg('新增 / added ' + body.added + ' · 合并 / merged ' + body.merged + (body.invalid ? ' · 无效 / invalid ' + body.invalid : ''));
              load(tab, q);
            })
            .catch(function (error) {
              setSyncMsg('导入失败 / import failed: ' + String(error.message || error));
            });
        };
        reader.readAsText(file);
      }

      var stats = data.stats;

      var kpis = h(
        'div',
        { className: 'kpis' },
        stats
          ? [
              kpi(stats.active, '生效 / active', 'ok'),
              kpi(stats.retired, '已退役 / retired', 'warn'),
              kpi(stats.hits, '注入 / injections', 'accent'),
              kpi(stats.shared, '共享 / shared', ''),
              kpi(formatBudget(data.budgetMs), '蒸馏预算 / budget', ''),
            ]
          : [h('div', { key: 'l', className: 'note' }, data.loading ? '加载中… / loading…' : '')],
      );

      // Evolution strip (ROADMAP 3.3): both UIs render it from one query layer.
      // Pure CSS bars — the offline rule holds here too (no external assets).
      var evolution = data.evolution;
      var evo = null;
      if (evolution) {
        var maxWeek = Math.max(1, Math.max.apply(null, evolution.newRules.concat(evolution.episodes)));
        var evoBar = function (value, key) {
          var pct = Math.max(2, Math.round((value / maxWeek) * 100));
          return h('i', { key: key, className: 'b', title: String(value), style: { height: pct + '%' } });
        };
        var sum = function (values) {
          return values.reduce(function (a, b) { return a + b; }, 0);
        };
        evo = h(
          'div',
          { className: 'evo' },
          h(
            'div',
            { className: 'evo-h' },
            h('b', null, '进化 / evolution (8w)'),
            h(
              'span',
              null,
              '新规则 / new: ' + sum(evolution.newRules) + ' · episodes: ' + sum(evolution.episodes),
            ),
          ),
          h(
            'div',
            { className: 'evo-bars' },
            h('div', { className: 'evo-col' }, evolution.newRules.map(evoBar)),
            h('div', { className: 'evo-col alt' }, evolution.episodes.map(evoBar)),
          ),
          h(
            'div',
            { className: 'evo-f' },
            '谱系 / lineage ' + evolution.lineage +
              ' · 用户纠正 / corrections ' + evolution.fromUserCorrection +
              ' · 弯路 / detours ' + evolution.detours +
              (evolution.probation > 0 ? ' · probation ' + evolution.probation : ''),
          ),
        );
      }

      var sorted = data.rows.slice().sort(function (a, b) {
        if (sort === 'hits') return b.hit_count - a.hit_count || a.id - b.id;
        if (sort === 'fails') return b.fail_count - a.fail_count || a.id - b.id;
        return String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id;
      });

      var body;
      if (data.error) {
        body = h(
          'div',
          { className: 'empty' },
          h('div', { className: 'glyph' }),
          h('div', { className: 't' }, '加载失败 / load failed'),
          h('div', { className: 'hd err' }, data.error),
        );
      } else if (data.loading && data.rows.length === 0) {
        body = h(
          'div',
          { className: 'skel' },
          [0, 1, 2, 3].map(function (n) {
            return h(
              'div',
              { className: 'r', key: n },
              h('div', { className: 'b' }),
              h('div', { className: 'b' }),
              h('div', { className: 'b' }),
              h('div', { className: 'b' }),
            );
          }),
        );
      } else if (sorted.length === 0) {
        body = h(
          'div',
          { className: 'empty' },
          h('div', { className: 'glyph' }),
          h(
            'div',
            { className: 't' },
            tab === 'shared' ? '共享库为空 / shared library is empty' : '还没有抗体 / no antibodies yet',
          ),
          h(
            'div',
            { className: 'hd' },
            tab === 'shared'
              ? '泛型坑在多个项目反复命中后才会晋升到这里。'
              : '工具先失败、随后用另一种方式成功之后才会产生。',
          ),
        );
      } else {
        body = h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['#', '触发 / trigger', '忌 / avoid', '宜 / do', 'hits / fails', '状态 / status', ''].map(function (label) {
                return h('th', { key: label }, label);
              }),
            ),
          ),
          h(
            'tbody',
            null,
            sorted.map(function (a) {
              return h(
                'tr',
                { key: a.id, className: a.status === 'retired' ? 'retired' : '' },
                h('td', { className: 'id', 'data-label': '#' }, String(a.id)),
                h('td', { className: 'trigger', 'data-label': '触发' }, a.trigger_pattern),
                h('td', { className: 'txt', 'data-label': '忌' }, a.symptom),
                h(
                  'td',
                  { className: 'txt do', 'data-label': '宜' },
                  a.prescription,
                  Array.isArray(a.repair_path) && a.repair_path.length > 0
                    ? h('div', { className: 'repair' }, '修复动作 / repaired by: ' + a.repair_path.join(' · '))
                    : null,
                ),
                h(
                  'td',
                  { className: 'counts', 'data-label': 'hits/fails' },
                  h('b', null, String(a.hit_count)),
                  ' / ',
                  h('span', { className: 'f' }, String(a.fail_count)),
                ),
                h(
                  'td',
                  { 'data-label': '状态' },
                  h('span', { className: 'pill ' + a.status }, a.status === 'active' ? '生效 / active' : '已退役 / retired'),
                ),
                h(
                  'td',
                  { className: 'ops', 'data-label': '' },
                  tab === 'project'
                    ? h(
                        'div',
                        { className: 'acts' },
                        h(
                          'button',
                          {
                            className: 'act',
                            type: 'button',
                            onClick: function () {
                              act(a.status === 'active' ? 'retire' : 'restore', a.id);
                            },
                          },
                          a.status === 'active' ? '退役 / retire' : '恢复 / restore',
                        ),
                        h(
                          'button',
                          { className: 'act danger', type: 'button', onClick: function () { act('delete', a.id); } },
                          '删除 / delete',
                        ),
                      )
                    : null,
                ),
              );
            }),
          ),
        );
      }

      return h(
        'div',
        { className: 'imm' },
        h('style', { id: STYLE_ID }, CSS),
        kpis,
        evo,
        h(
          'div',
          { className: 'row' },
          h(
            'div',
            { className: 'search' },
            h('span', { className: 'glass', 'aria-hidden': 'true' }),
            h('input', {
              type: 'search',
              placeholder: '搜索触发词、症状或处方… / search…',
              value: q,
              'aria-label': 'search antibodies',
              onChange: function (e) {
                onQuery(e.target.value);
              },
            }),
            h(
              'button',
              {
                className: q ? 'x on' : 'x',
                type: 'button',
                title: '清除 / clear',
                onClick: function () {
                  onQuery('');
                },
              },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'seg', role: 'tablist' },
            h(
              'button',
              {
                className: tab === 'project' ? 'on' : '',
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'project' ? 'true' : 'false',
                onClick: function () { setTab('project'); },
              },
              '项目 / project',
              h('b', null, stats ? String(stats.active + stats.retired) : ''),
            ),
            h(
              'button',
              {
                className: tab === 'shared' ? 'on' : '',
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'shared' ? 'true' : 'false',
                onClick: function () { setTab('shared'); },
              },
              '共享 / shared',
              h('b', null, stats ? String(stats.shared) : ''),
            ),
          ),
          h(
            'select',
            {
              value: sort,
              'aria-label': 'sort antibodies',
              onChange: function (e) { setSort(e.target.value); },
            },
            h('option', { value: 'recent' }, '最近更新 / recent'),
            h('option', { value: 'hits' }, '命中最多 / most hits'),
            h('option', { value: 'fails' }, '失效最多 / most fails'),
          ),
        ),
        h(
          'div',
          { className: 'panel' },
          h(
            'div',
            { className: 'meta-row' },
            h('span', null, sorted.length + ' 条结果 / results'),
            h('span', null, stats ? '蒸馏预算 / budget ' + formatBudget(data.budgetMs) : ''),
            h(
              'span',
              null,
              stats && stats.dbBytes != null
                ? Math.max(1, Math.round(stats.dbBytes / 1024)) +
                    ' KiB · ' +
                    stats.sessions +
                    ' 会话 / sessions · ' +
                    stats.jobsTotal +
                    ' 任务 / jobs · ' +
                    Math.max(0, (stats.hits || 0) - (stats.fails || 0)) +
                    ' 未失败 / held · ' +
                    (stats.suppressedRepeats || 0) +
                    ' 拦截 / intercepted' +
                    (stats.llmDistilled || stats.llmFallbacks
                      ? ' · 模型 / model ' +
                        (stats.llmDistilled || 0) +
                        (stats.llmFallbacks ? ' (+' + stats.llmFallbacks + ' degraded)' : '')
                      : '')
                : '',
            ),
            h('a', { href: API + '/export?format=md', download: 'immune-library.md' }, '导出 / export'),
            h(
              'label',
              { className: 'imm-import' },
              '导入 / import',
              h('input', {
                type: 'file',
                accept: '.json,application/json',
                style: { display: 'none' },
                onChange: doImport,
              }),
            ),
            syncMsg ? h('span', null, syncMsg) : null,
          ),
          body,
        ),
        h('div', { className: 'note' }, '浏览不计入命中数——只有真正注入给模型才算一次命中。 / browsing is not injection.'),
      );
    }

    /**
     * Render the panel inside a shadow root.
     *
     * The settings modal is an unknown host: its global stylesheet can (and in
     * practice does) reshape bare `table`/`td`/`div` inside a plugin tab, which
     * collapsed our rows and hid the sort control. A shadow root seals both
     * directions — the host CSS cannot reach in, and our tokens cannot leak out.
     * Only inherited properties (font, colour, line-height) cross the boundary,
     * so `.imm` still pins those explicitly.
     *
     * If the browser has no shadow DOM, or react-dom is unavailable for portals,
     * fall back to plain rendering; the defensive CSS in the style block keeps
     * that readable.
     */
    function ImmuneTab() {
      var host = React.useRef(null);
      var target = React.useState(null);
      var mount = target[0];
      var setMount = target[1];

      React.useEffect(function () {
        var node = host.current;
        if (!node || !ReactDOM || typeof node.attachShadow !== 'function') return undefined;
        var shadow = node.shadowRoot || node.attachShadow({ mode: 'open' });
        var slot = shadow.querySelector('div[data-immune-root]');
        if (!slot) {
          slot = document.createElement('div');
          slot.setAttribute('data-immune-root', '1');
          shadow.appendChild(slot);
        }
        setMount(slot);
        return undefined;
      }, []);

      var ready = mount !== null && ReactDOM !== null && typeof ReactDOM.createPortal === 'function';
      return h(
        'div',
        { ref: host, className: 'shield', style: { display: 'block', width: '100%', minWidth: 0 } },
        ready ? ReactDOM.createPortal(h(ImmunePanel, null), mount) : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'immune',
            order: 40,
            label: function () {
              return '免疫 / Immune';
            },
          },
          ImmuneTab,
        );
      });
    }

    exports.name = 'dsh-immune-system';
    exports.inject = ['slots'];
    exports.apply = apply;
    // Exposed for the offline render harness (scripts/render-tab.mjs); the host
    // only uses `apply`. Harmless if a future host ignores it.
    exports.__tab = ImmuneTab;
    return module.exports;
  },
});
