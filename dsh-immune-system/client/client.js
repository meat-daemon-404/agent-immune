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

    var API = '/plugins/dsh-immune-system/api';

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

    function formatTime(ms) {
      try {
        return new Date(ms).toLocaleString();
      } catch (e) {
        return '';
      }
    }

    var S = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 2px', fontSize: '13px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      stats: { display: 'flex', gap: '14px', flexWrap: 'wrap', color: 'var(--dsh-text-secondary, #8b94a3)' },
      statB: { color: 'var(--dsh-text-primary, inherit)', marginRight: '4px' },
      input: {
        flex: '1 1 220px',
        minWidth: '160px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsh-border, #2c3240)',
        background: 'var(--dsh-bg-secondary, #141821)',
        color: 'inherit',
        fontSize: '13px',
      },
      tab: {
        padding: '5px 12px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-border, #2c3240)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      tabOn: {
        borderColor: 'var(--dsh-accent, #4f9cf9)',
        color: 'var(--dsh-accent, #4f9cf9)',
      },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: {
        textAlign: 'left',
        padding: '6px 8px',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        color: 'var(--dsh-text-secondary, #8b94a3)',
        borderBottom: '1px solid var(--dsh-border, #2c3240)',
      },
      td: {
        padding: '8px',
        borderBottom: '1px solid var(--dsh-border, #242a36)',
        verticalAlign: 'top',
      },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' },
      btn: {
        padding: '3px 8px',
        marginRight: '6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #2c3240)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      muted: { color: 'var(--dsh-text-secondary, #8b94a3)' },
      note: { fontSize: '12px', color: 'var(--dsh-text-secondary, #8b94a3)' },
    };

    function ImmuneTab() {
      var state = React.useState({ loading: true, error: '', stats: null, rows: [] });
      var view = React.useState('project');
      var query = React.useState('');

      var data = state[0];
      var setData = state[1];
      var tab = view[0];
      var setTab = view[1];
      var q = query[0];
      var setQ = query[1];

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
              setData({ loading: false, error: '', stats: body.stats, rows: body.antibodies });
            })
            .catch(function (error) {
              setData({ loading: false, error: String(error.message || error), stats: null, rows: [] });
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

      var stats = data.stats;
      var header = h(
        'div',
        { style: S.stats },
        stats
          ? [
              h('span', { key: 'a' }, h('b', { style: S.statB }, String(stats.active)), '生效 / active'),
              h('span', { key: 'r' }, h('b', { style: S.statB }, String(stats.retired)), '已退役 / retired'),
              h('span', { key: 'h' }, h('b', { style: S.statB }, String(stats.hits)), '注入 / injections'),
              h('span', { key: 's' }, h('b', { style: S.statB }, String(stats.shared)), '共享 / shared'),
            ]
          : [h('span', { key: 'l' }, data.loading ? '加载中… / loading…' : '')],
      );

      var rows = data.rows.map(function (a) {
        return h(
          'tr',
          { key: a.id },
          h('td', { style: S.td }, String(a.id)),
          h('td', { style: Object.assign({}, S.td, S.mono) }, a.trigger_pattern),
          h('td', { style: S.td }, a.symptom),
          h('td', { style: S.td }, a.prescription),
          h('td', { style: Object.assign({}, S.td, S.muted) }, a.hit_count + ' / ' + a.fail_count),
          h('td', { style: Object.assign({}, S.td, S.muted) }, a.status),
          h(
            'td',
            { style: S.td },
            tab === 'project'
              ? [
                  h(
                    'button',
                    {
                      key: 't',
                      style: S.btn,
                      onClick: function () {
                        act(a.status === 'active' ? 'retire' : 'restore', a.id);
                      },
                    },
                    a.status === 'active' ? '退役 / retire' : '恢复 / restore',
                  ),
                  h(
                    'button',
                    { key: 'd', style: S.btn, onClick: function () { act('delete', a.id); } },
                    '删除 / delete',
                  ),
                ]
              : null,
          ),
        );
      });

      return h(
        'div',
        { style: S.root },
        header,
        h(
          'div',
          { style: S.row },
          h('input', {
            style: S.input,
            type: 'search',
            placeholder: '搜索触发词、症状或处方… / search…',
            value: q,
            onChange: function (e) {
              onQuery(e.target.value);
            },
          }),
          h(
            'button',
            {
              style: Object.assign({}, S.tab, tab === 'project' ? S.tabOn : null),
              onClick: function () {
                setTab('project');
              },
            },
            '项目 / project',
          ),
          h(
            'button',
            {
              style: Object.assign({}, S.tab, tab === 'shared' ? S.tabOn : null),
              onClick: function () {
                setTab('shared');
              },
            },
            '共享 / shared',
          ),
        ),
        data.error
          ? h('div', { style: S.note }, '加载失败 / load failed: ' + data.error)
          : data.rows.length === 0
            ? h(
                'div',
                { style: S.note },
                tab === 'shared'
                  ? '共享库为空。泛型坑在多次命中后才会晋升。/ Shared library is empty.'
                  : '还没有抗体。工具先失败、随后成功之后才会产生。/ No antibodies yet.',
              )
            : h(
                'table',
                { style: S.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['#', '触发 / trigger', '忌 / avoid', '宜 / do', 'hits/fails', 'status', ''].map(function (label) {
                      return h('th', { key: label, style: S.th }, label);
                    }),
                  ),
                ),
                h('tbody', null, rows),
              ),
        h('div', { style: S.note }, '浏览不计入命中数 / browsing does not count as injection.'),
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
    return module.exports;
  },
});
