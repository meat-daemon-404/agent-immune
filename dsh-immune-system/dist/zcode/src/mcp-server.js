/**
 * MCP server — the library as tools, reachable from any MCP-capable agent.
 *
 * The strongest lesson from surveying prior art (pro-workflow, 2.9k★): the
 * memory is only worth as much as the number of agents that can reach it.
 * "MCP works across every agent with the same setup" — one stdio server makes
 * the antibody library usable from Codex, Cursor, Cline and the rest, not just
 * the two hosts this plugin binds directly.
 *
 * Zero dependencies, JSON-RPC 2.0 over stdio, line-delimited. Implementations:
 *   initialize            → protocol handshake
 *   tools/list            → the tools below (library CRUD plus the read-only
 *                           audit preview and seed-pack listing)
 *   tools/call            → dispatch, text content back
 *   ping                  → liveness
 * Anything else answers method-not-found, and notifications are ignored.
 *
 * Every tool is read-heavy by design; the two mutations (learn / forget) mirror
 * the CLI exactly, including zombie semantics.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ImmuneStore } from '../../core/store/index.js';
import { renderSkillMarkdown } from '../../core/export.js';
import { auditHistory, renderAuditReport } from '../../core/audit.js';
import { BUILTIN_PACKS } from '../../core/packs.js';
import { packageVersion } from '../../core/version.js';
const SERVER_INFO = { name: 'dsh-immune-system', version: packageVersion() };
const TOOLS = [
    {
        name: 'immune_list',
        description: 'List pitfall antibodies this project has learned. Each has a trigger (when it applies), a symptom (the wrong instinct) and a prescription (the verified fix).',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Optional full-text filter over trigger/symptom/prescription.' },
                includeRetired: { type: 'boolean', description: 'Include retired rules. Default false.' },
                limit: { type: 'number', description: 'Max rows. Default 50.' },
            },
        },
    },
    {
        name: 'immune_stats',
        description: 'Counts: active/retired rules, total injections, queued distillation jobs, database path.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'immune_export',
        description: 'Render the proven rules (hits >= threshold) as a SKILL.md document and return its text. Save the text to share the library with teammates or commit it.',
        inputSchema: {
            type: 'object',
            properties: {
                minHits: { type: 'number', description: 'Minimum hit count. Default 3.' },
                title: { type: 'string', description: 'Skill title. Default "project-pitfalls".' },
            },
        },
    },
    {
        name: 'immune_learn',
        description: 'Teach a rule directly, without waiting for a failed-then-fixed episode. Use for conventions the agent keeps getting wrong.',
        inputSchema: {
            type: 'object',
            properties: {
                trigger: { type: 'string', description: 'When the rule applies: file names, commands, error keywords. Space separated.' },
                symptom: { type: 'string', description: 'The wrong instinct, one line.' },
                prescription: { type: 'string', description: 'The verified correct move, one line.' },
            },
            required: ['trigger', 'symptom', 'prescription'],
        },
    },
    {
        name: 'immune_forget',
        description: 'Remove a rule by id (from immune_list). Physical delete; prefer immune_retire when unsure.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number', description: 'Antibody id.' } },
            required: ['id'],
        },
    },
    {
        name: 'immune_retire',
        description: 'Stop injecting a rule without deleting it. Reversible with immune_restore.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number' } },
            required: ['id'],
        },
    },
    {
        name: 'immune_restore',
        description: 'Put a retired rule back into rotation.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number' } },
            required: ['id'],
        },
    },
    {
        name: 'immune_audit',
        description: 'Health check over this machine\'s session history (ZCode db, Codex rollouts, Claude Code transcripts): replays the failed-then-fixed pairing and reports per-tool failures, repeat offenders and the avoidable token estimate. READ-ONLY preview — run `immune audit` in a terminal to actually distil (an MCP-only host has no turn-end drain, so enqueued jobs would sit stuck).',
        inputSchema: {
            type: 'object',
            properties: {
                days: { type: 'number', description: 'Look back this many days. Default 30.' },
            },
        },
    },
    {
        name: 'immune_seed_packs',
        description: 'List the builtin seed packs (git-safety, node-ts, python-uv, docker) with per-pack seeded counts. Install with `immune seed <id>` in a terminal; this tool never writes.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'immune_detours',
        description: 'List recent convergent detours: sessions that probed one target 4+ times read-only before the successful command landed. Telemetry / review candidates — the engine never mints a shortcut rule from these (that stays on the LLM rewrite path). READ-ONLY.',
        inputSchema: {
            type: 'object',
            properties: { limit: { type: 'number', description: 'Rows to show. Default 20.' } },
        },
    },
];
/** Dispatch one tools/call. Kept pure-ish so tests can call it without stdio. */
export function callTool(store, name, args) {
    switch (name) {
        case 'immune_list': {
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            const includeRetired = args.includeRetired === true;
            const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 50;
            let rows = query
                ? store.peek(query, limit)
                : store.listAll(includeRetired).slice(0, limit);
            if (query && includeRetired) {
                // peek reads active only through findMatches; merge retired matches so
                // the filter stays honest without duplicating the query machinery.
                const extra = store
                    .listAll(true)
                    .filter((a) => a.status === 'retired')
                    .filter((a) => `${a.trigger_pattern} ${a.symptom} ${a.prescription}`.toLowerCase().includes(query.toLowerCase()))
                    .slice(0, limit);
                const have = new Set(rows.map((r) => r.id));
                rows = [...rows, ...extra.filter((r) => !have.has(r.id))].slice(0, limit);
            }
            if (rows.length === 0)
                return 'No antibodies match.';
            return rows
                .map((a) => `#${a.id} [${a.status}] hits ${a.hit_count}/fails ${a.fail_count}\n` +
                `  trigger: ${a.trigger_pattern}\n  avoid: ${a.symptom}\n  do: ${a.prescription}`)
                .join('\n\n');
        }
        case 'immune_stats': {
            const all = store.listAll(true);
            return (`active: ${all.filter((a) => a.status === 'active').length}\n` +
                `retired: ${all.filter((a) => a.status === 'retired').length}\n` +
                `injections: ${all.reduce((s, a) => s + a.hit_count, 0)}\n` +
                `queued distill jobs: ${store.pendingJobCount()}\n` +
                `database: ${store.dbPath}`);
        }
        case 'immune_export': {
            const minHits = typeof args.minHits === 'number' && args.minHits > 0 ? args.minHits : 3;
            const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'project-pitfalls';
            const rows = store.exportable(minHits);
            if (rows.length === 0) {
                return `No rule has reached ${minHits} hits yet; nothing worth sharing.`;
            }
            const md = renderSkillMarkdown(rows, { minHits, title });
            return `Exported ${rows.length} rules as SKILL.md:\n\n${md}`;
        }
        case 'immune_learn': {
            const trigger = typeof args.trigger === 'string' ? args.trigger : '';
            const symptom = typeof args.symptom === 'string' ? args.symptom : '';
            const prescription = typeof args.prescription === 'string' ? args.prescription : '';
            if (!trigger.trim() || !prescription.trim()) {
                return 'error: trigger and prescription are required (symptom optional but recommended).';
            }
            const id = store.insert({
                trigger_pattern: trigger,
                symptom: symptom || '(manual rule)',
                prescription,
                tool_name: null,
            });
            return id === null ? 'error: could not store the rule (duplicate prescription?).' : `learned as #${id}.`;
        }
        case 'immune_forget': {
            const id = typeof args.id === 'number' ? args.id : Number.NaN;
            if (!Number.isInteger(id) || id <= 0)
                return 'error: id must be a positive integer.';
            return store.remove(id) ? `deleted #${id}.` : `no antibody #${id}.`;
        }
        case 'immune_retire': {
            const id = typeof args.id === 'number' ? args.id : Number.NaN;
            if (!Number.isInteger(id) || id <= 0)
                return 'error: id must be a positive integer.';
            return store.setStatus(id, 'retired') ? `retired #${id}.` : `no antibody #${id}.`;
        }
        case 'immune_restore': {
            const id = typeof args.id === 'number' ? args.id : Number.NaN;
            if (!Number.isInteger(id) || id <= 0)
                return 'error: id must be a positive integer.';
            return store.setStatus(id, 'active') ? `restored #${id}.` : `no antibody #${id}.`;
        }
        case 'immune_audit': {
            // Always a dry-run: an MCP-only host has no Stop hook to drain enqueued
            // jobs, so the applying pass belongs to the terminal CLI.
            const days = typeof args.days === 'number' && Number.isFinite(args.days) && args.days > 0
                ? Math.trunc(args.days)
                : 30;
            try {
                const report = auditHistory(store, { days, dryRun: true });
                return renderAuditReport(report, days, true);
            }
            catch (error) {
                return `error: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        case 'immune_seed_packs': {
            const counts = store.seededPackCounts();
            const lines = BUILTIN_PACKS.map((pack) => {
                const installed = counts.get(pack.id) ?? 0;
                return `${pack.id.padEnd(12)} ${String(installed).padStart(2)}/${pack.rules.length} seeded · ${pack.label} — ${pack.description}`;
            });
            return `Builtin seed packs (install with \`immune seed <id>\` in a terminal; this tool never writes):\n${lines.join('\n')}`;
        }
        case 'immune_detours': {
            const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
                ? Math.min(100, Math.trunc(args.limit))
                : 20;
            const rows = store.recentDetours(limit);
            if (rows.length === 0) {
                return 'no convergent detours recorded (4+ same-target probes before the fix). Telemetry only — `immune rewrite` is the minting path.';
            }
            const lines = rows.map((row) => {
                const when = new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ');
                return `${when}  ${String(row.probes).padStart(2)} probes  ${row.signature}`;
            });
            return `convergent detours (telemetry — \`immune rewrite\` is the minting path):\n${lines.join('\n')}`;
        }
        default:
            return `error: unknown tool ${name}`;
    }
}
/** Run the stdio loop. Resolves when stdin closes. */
export function runMcpServer(env = process.env) {
    const store = new ImmuneStore(env.IMMUNE_DB_PATH ? { dbPath: env.IMMUNE_DB_PATH } : {});
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin });
        const write = (payload) => {
            process.stdout.write(JSON.stringify(payload) + '\n');
        };
        rl.on('line', (line) => {
            const text = line.trim();
            if (!text)
                return;
            let message;
            try {
                message = JSON.parse(text);
            }
            catch {
                return; // A stray non-JSON line must not kill the server.
            }
            const params = (message.params ?? {});
            const id = message.id;
            if (id === undefined || id === null)
                return; // notification: no response
            const method = typeof message.method === 'string' ? message.method : '';
            switch (method) {
                case 'initialize':
                    write({
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: SERVER_INFO,
                        },
                    });
                    break;
                case 'tools/list':
                    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
                    break;
                case 'ping':
                    write({ jsonrpc: '2.0', id, result: {} });
                    break;
                case 'tools/call': {
                    const params = (message.params ?? {});
                    const name = typeof params.name === 'string' ? params.name : '';
                    const args = (params.arguments ?? {});
                    if (!name || !TOOLS.some((t) => t.name === name)) {
                        write({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32602, message: `unknown tool: ${name || '(none)'}` },
                        });
                        break;
                    }
                    try {
                        const text = callTool(store, name, args);
                        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
                    }
                    catch (error) {
                        write({
                            jsonrpc: '2.0',
                            id,
                            result: {
                                content: [{ type: 'text', text: `error: ${error instanceof Error ? error.message : String(error)}` }],
                                isError: true,
                            },
                        });
                    }
                    break;
                }
                default:
                    write({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: `method not found: ${method}` },
                    });
            }
        });
        rl.on('close', () => {
            store.close();
            resolve();
        });
    });
}
// Entry-point guard: running this file as a process starts the stdio loop;
// importing it (the tests) only gets callTool without a live server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void runMcpServer();
}
