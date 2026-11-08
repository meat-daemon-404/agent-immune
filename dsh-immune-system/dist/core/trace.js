/**
 * Trace readers: pull the human-meaningful part out of a compact tool trace.
 *
 * Traces look like:
 *   tool=Bash input={"command":"npm run build"} error=ENOENT: not found
 *   tool=Edit input={"file_path":"a.ts"} result=[{"type":"text","text":"ok"}]
 */
/** Read a double-quoted JSON string body starting at `from`, unescaping as we go. */
function readJsonString(trace, from) {
    let value = '';
    for (let i = from; i < trace.length; i += 1) {
        const ch = trace[i];
        if (ch === '\\' && i + 1 < trace.length) {
            const esc = trace[i + 1] ?? '';
            if (esc === 'u' && i + 5 < trace.length) {
                const code = Number.parseInt(trace.slice(i + 2, i + 6), 16);
                if (Number.isFinite(code)) {
                    value += String.fromCharCode(code);
                    i += 5;
                    continue;
                }
            }
            // The old code appended the escaped character and dropped the backslash,
            // so `\n` became the LETTER "n": a heredoc or any multi-line command
            // arrived as `2>&1n# Put webp…` and that mash was stored as the
            // prescription. Traces are single-line, so line breaks become a space;
            // `\"`, `\\` and `\/` still decode to their characters.
            value += /[nrtbf]/.test(esc) ? ' ' : esc;
            i += 1;
            continue;
        }
        if (ch === '"')
            return value;
        value += ch;
    }
    return null;
}
/**
 * Find the string value of the first `key` inside a JSON-looking fragment.
 * Hand-rolled for the same reason as `extractInvocation`: no regex traps, no
 * trusting a JSON.parse on model/runtime debris.
 */
function jsonStringField(text, keys) {
    if (!text.startsWith('{') && !text.startsWith('['))
        return null;
    for (const key of keys) {
        let at = text.indexOf(`"${key}"`);
        while (at >= 0) {
            const colon = text.indexOf(':', at + key.length + 2);
            const open = colon >= 0 ? text.indexOf('"', colon + 1) : -1;
            if (open >= 0) {
                const value = readJsonString(text, open + 1);
                if (value && value.trim())
                    return value;
            }
            at = text.indexOf(`"${key}"`, at + key.length + 2);
        }
    }
    return null;
}
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
    const raw = (at >= 0 ? trace.slice(at + width) : trace).replace(/\s+/g, ' ').trim();
    if (!raw)
        return null;
    // Edit/Read results and structured payloads arrive as JSON block arrays; the
    // human part lives in a string field inside them, not in the JSON wrapper.
    const unwrapped = jsonStringField(raw, ['message', 'text', 'error', 'stderr']);
    const text = (unwrapped ?? raw).replace(/\s+/g, ' ').trim();
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
        const value = readJsonString(trace, start + needle.length);
        const clean = (value ?? '').replace(/\s+/g, ' ').trim();
        if (clean)
            return clean.slice(0, 120);
    }
    return null;
}
