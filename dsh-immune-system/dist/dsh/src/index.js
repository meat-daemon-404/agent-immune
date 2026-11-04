/**
 * DSH plugin entry — Cordis/Koishi-style (`name` + `apply(ctx)`).
 *
 * Shares `core/` with the ZCode plugin, so behaviour and storage format are
 * identical. Only the host binding differs, and that lives in
 * `dsh-adapter.ts`.
 *
 * UNVERIFIED: see the header of `dsh-adapter.ts` for the contract that must be
 * confirmed against a real DSH build before relying on this.
 */
import { ImmuneStore } from '../../core/store/index.js';
import { renderSkillMarkdown } from '../../core/export.js';
import { distillEpisode } from '../../core/distiller.js';
import { DSH_EVENTS, makeLogger, normaliseToolEvent, } from './dsh-adapter.js';
export const name = 'dsh-immune-system';
/** Render antibodies as the compact advisory block. */
function renderMemory(blocks) {
    if (blocks.length === 0)
        return '';
    const body = blocks
        .map((b, i) => `${i + 1}. [trigger: ${b.trigger_pattern}] avoid: ${b.symptom} -> do: ${b.prescription}`)
        .join('\n');
    return `<immune_memory>\nPitfalls this project already paid for. Advisory only.\n${body}\n</immune_memory>`;
}
/** Drain queued jobs inline; DSH has no separate turn-end event to defer to. */
async function drain(store, budgetMs = 8000) {
    const deadline = Date.now() + budgetMs;
    store.requeueStuckJobs();
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        const job = store.claimJob();
        if (!job)
            break;
        try {
            const result = await distillEpisode(job.tool_name, job.failure_trace, job.success_trace, {
                signal: AbortSignal.timeout(Math.max(1000, remaining)),
            });
            if (result.ok) {
                store.insert(result.antibody);
                store.finishJob(job.id, 'done');
            }
            else {
                store.finishJob(job.id, result.reason === 'skip' ? 'skipped' : 'failed', result.detail ?? '');
            }
        }
        catch (error) {
            store.finishJob(job.id, 'failed', error instanceof Error ? error.message : String(error));
        }
    }
}
export function apply(ctx) {
    const log = makeLogger(ctx);
    const store = new ImmuneStore();
    log.info(`[immune] storage: ${store.dbPath}`);
    // Inject before the model request.
    ctx.on(DSH_EVENTS.beforeRequest, (payload) => {
        const session = payload;
        const prompt = session?.lastUserMessage ?? '';
        if (!prompt)
            return undefined;
        const hits = store.match(prompt, { limit: 3 });
        const block = renderMemory(hits);
        if (block && typeof session.appendSystemReminder === 'function') {
            session.appendSystemReminder(block);
        }
        return undefined;
    });
    // Prime a new session with the project's most-used antibodies.
    ctx.on(DSH_EVENTS.sessionStart, (payload) => {
        const session = payload;
        const block = renderMemory(store.listAll(false).slice(0, 3));
        if (block && typeof session.appendSystemReminder === 'function') {
            session.appendSystemReminder(block);
        }
        return undefined;
    });
    // Sense the failure -> success inflection.
    ctx.on(DSH_EVENTS.afterToolCall, async (payload) => {
        const event = normaliseToolEvent(payload);
        if (!event.ok) {
            const snapshot = store.recordFailure(event.sessionId, event.toolName, event.errorText);
            const retired = store.penalize(snapshot.injected_ids, {
                failureText: snapshot.trace,
                toolName: event.toolName,
            });
            for (const ab of retired) {
                store.enqueueJob(event.toolName, `retired #${ab.id}: ${ab.prescription}`, snapshot.trace, []);
            }
            return undefined;
        }
        const failure = store.claimFailure(event.sessionId, event.toolName);
        if (failure) {
            store.enqueueJob(event.toolName, failure.trace, event.resultText, failure.injected_ids);
            // No turn-end hook here, so distillation runs after the episode closes.
            await drain(store);
        }
        return undefined;
    });
    ctx.command('immune', 'List the pitfall antibodies this project has learned', async (args) => {
        const includeRetired = args.includes('--all');
        const rows = store.listAll(includeRetired);
        if (rows.length === 0)
            return 'No antibodies yet.';
        return rows
            .map((a) => `#${a.id} [hits ${a.hit_count}/fails ${a.fail_count}] ${a.status}\n  trigger: ${a.trigger_pattern}\n  avoid: ${a.symptom}\n  do: ${a.prescription}`)
            .join('\n\n');
    });
    ctx.command('immune-export', 'Export proven antibodies as a project-pitfalls skill', async () => {
        const rows = store.exportable(3);
        if (rows.length === 0)
            return 'No antibody reached 3 hits yet.';
        const md = renderSkillMarkdown(rows, { minHits: 3 });
        return `Exported ${rows.length} antibodies:\n\n${md}`;
    });
}
