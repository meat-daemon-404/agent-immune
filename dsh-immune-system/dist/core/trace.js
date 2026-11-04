/** Extract the error/result text from a trace, without the tool input preamble. */
export function extractError(trace) {
    const markers = ['error=', 'result='];
    let at = -1;
    let width = 0;
    for (const marker of markers) {
        const idx = trace.lastIndexOf(marker);
        if (idx > at) {
            at = idx;
            width = marker.length;
        }
    }
    const text = (at >= 0 ? trace.slice(at + width) : trace).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 100) : null;
}
const KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'script'];
/**
 * The command, path or query that was actually run.
 *
 * Parsed by scanning for the key then reading to the closing unescaped quote,
 * which avoids both a fragile regex and a `JSON.parse` of untrusted fragments.
 */
export function extractInvocation(trace) {
    for (const key of KEYS) {
        const needle = `"${key}":"`;
        const start = trace.indexOf(needle);
        if (start < 0)
            continue;
        const from = start + needle.length;
        let value = '';
        for (let i = from; i < trace.length; i += 1) {
            const ch = trace[i];
            if (ch === '\\' && i + 1 < trace.length) {
                value += trace[i + 1];
                i += 1;
                continue;
            }
            if (ch === '"')
                break;
            value += ch;
        }
        const clean = value.replace(/\s+/g, ' ').trim();
        if (clean)
            return clean.slice(0, 120);
    }
    return null;
}
