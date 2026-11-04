/**
 * Decide whether a PostToolUse payload represents a failed call.
 *
 * Why this exists: `PostToolUseFailure` is dispatched only when the tool
 * *handler throws* (the executor's catch block). A shell command that exits
 * non-zero usually returns normally, so relying on that event alone would miss
 * exactly the failures this plugin is built to learn from.
 *
 * So PostToolUse is classified here instead, and the two paths converge.
 */
/** Check for a non-zero numeric exit code in a few plausible spellings. */
function exitCodeOf(response) {
    if (typeof response !== 'object' || response === null)
        return null;
    const raw = response;
    for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string' && /^-?\d+$/.test(value))
            return Number(value);
    }
    return null;
}
/**
 * Markers that strongly indicate a failure in captured output.
 *
 * Deliberately narrow: a successful build log can contain the word "error", so
 * only specific shapes count. A false positive here would record a healthy call
 * as a pitfall.
 */
const FAILURE_MARKERS = /\bexit (?:code|status)\s*[:=]?\s*[1-9]\d*\b|ENOENT|EACCES|EPERM|ECONNREFUSED|command not found|is not recognized as an internal|Traceback \(most recent call last\)|npm ERR!|\bfatal:\s|^Error:|Cannot find module/i;
/** Classify one successful-looking tool result as failure or success. */
export function classifyOutcome(event) {
    const response = event.tool_response ?? event.toolResponse;
    const preview = typeof event.tool_result_preview === 'string' ? event.tool_result_preview : '';
    const body = preview ||
        (typeof response === 'string' ? response : '') ||
        (() => {
            try {
                return JSON.stringify(response ?? '');
            }
            catch {
                return '';
            }
        })();
    const exit = exitCodeOf(response);
    if (exit !== null) {
        return { failed: exit !== 0, text: body || `exit code ${exit}` };
    }
    if (typeof response === 'object' && response !== null) {
        const obj = response;
        if (obj.is_error === true || obj.isError === true || obj.error) {
            return { failed: true, text: body || String(obj.error ?? 'error') };
        }
    }
    if (FAILURE_MARKERS.test(body))
        return { failed: true, text: body };
    return { failed: false, text: body };
}
