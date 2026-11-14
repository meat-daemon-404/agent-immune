/**
 * Where the library is blind.
 *
 * The plugin can only inject rules it has learned. Everything else is a failure
 * the agent will repeat — and until now nothing counted them. This reads the
 * host's own error rows, asks the READ-ONLY retrieval path (peek: no hit
 * inflation) whether any rule would have matched, and groups the misses by a
 * normalized signature so the top blind spots are visible.
 *
 * It answers a question `stats` cannot: a library with 100% "held up" can still
 * be useless if the failures that actually happen are ones it never learned.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { hostDbPath } from './store/models.js';
import { isRelated } from './relevance.js';
/**
 * Failures nobody could write a rule for: the user cancelled the call, the
 * host refused it by policy, or the connection dropped. The distiller already
 * skips these as episodes; counting them as "uncovered" only makes the
 * percentage look worse than it is.
 */
const NOISE = /(was cancelled|was aborted|execution cancelled|timed out after \d+ms|econnreset|interrupted|plan mode only allows|context (?:window|length) exceeded|\[sandbox:\s*file access denied|user rejected|permission denied by user)/i;
export function isNoiseFailure(text) {
    return NOISE.test(text);
}
/** Absolute paths, numbers and quoted literals vary per instance; the shape does not. */
export function normaliseFailure(text) {
    return text
        .toLowerCase()
        .replace(/[a-z]:\\[^\s'"]+/g, '<path>')
        .replace(/\/[^\s'"]+/g, (m) => (m.length > 3 ? '<path>' : m))
        .replace(/\b\d+(?:\.\d+)?\b/g, '#')
        .replace(/['"][^'"]*['"]/g, '<str>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
}
export function coverage(store, opts = {}) {
    const days = Number.isFinite(opts.days) && (opts.days ?? 0) > 0 ? Math.trunc(opts.days) : 30;
    const top = Number.isFinite(opts.top) && (opts.top ?? 0) > 0 ? Math.trunc(opts.top) : 10;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const sourceDb = opts.sourceDb?.trim() || hostDbPath(opts.env ?? process.env);
    const report = {
        days,
        failures: 0,
        noise: 0,
        covered: 0,
        deliverable: 0,
        uncovered: 0,
        clusters: [],
    };
    if (!existsSync(sourceDb))
        return report;
    let db = null;
    try {
        db = new DatabaseSync(sourceDb, { readOnly: true });
        const rows = db
            .prepare(`SELECT session_id, tool_name, error_message FROM tool_usage
          WHERE started_at >= ? AND status = 'error' AND length(error_message) > 0
          ORDER BY started_at DESC LIMIT ?`)
            .all(since, 20_000);
        // "Covered" must mean "a rule that plausibly applies", not "the FTS index
        // returned something": with one shared word, a 573-failure replay reported
        // 99% coverage for an eight-rule library. This is the same relevance test
        // anti-rot uses before blaming a rule.
        //
        // Both statuses count as knowledge. A retired rule was still learned from a
        // real failure; anti-rot stopped injecting it because it did not prevent
        // repeats, which is a delivery problem, not a blind spot. Reporting the two
        // numbers apart keeps "we know this" from collapsing into "we have no idea"
        // the moment a rule retires.
        const rules = store.listAll(true);
        const groups = new Map();
        for (const row of rows) {
            report.failures += 1;
            if (isNoiseFailure(row.error_message)) {
                report.noise += 1;
                continue;
            }
            const related = rules.filter((rule) => {
                // A rule is written for one tool (or for no tool at all). An Edit
                // failure is not covered by a Bash rule that happens to share a word.
                const sameTool = !rule.tool_name || rule.tool_name.toLowerCase() === row.tool_name.toLowerCase();
                return sameTool && isRelated(rule.trigger_pattern, row.error_message, row.tool_name);
            });
            if (related.length > 0) {
                report.covered += 1;
                if (related.some((rule) => rule.status === 'active'))
                    report.deliverable += 1;
                continue;
            }
            report.uncovered += 1;
            const signature = normaliseFailure(row.error_message);
            const key = `${row.tool_name}::${signature}`;
            const group = groups.get(key);
            if (group) {
                group.count += 1;
                group.sessions.add(row.session_id);
            }
            else {
                groups.set(key, {
                    tool: row.tool_name,
                    signature,
                    count: 1,
                    sessions: new Set([row.session_id]),
                    example: row.error_message.split('\n')[0].slice(0, 160),
                });
            }
        }
        report.clusters = [...groups.values()]
            .map((group) => ({
            tool: group.tool,
            signature: group.signature,
            count: group.count,
            sessions: group.sessions.size,
            example: group.example,
        }))
            .sort((a, b) => b.count - a.count)
            .slice(0, top);
    }
    catch {
        // A missing table or a locked database means "no data", not "no coverage".
        return report;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // Read-only probe; a failed close is not worth an exception.
        }
    }
    return report;
}
