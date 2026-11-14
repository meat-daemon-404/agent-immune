/**
 * Redaction helpers.
 *
 * Hook stdin can carry secrets (API keys in a failed curl, tokens in an env
 * dump). We persist failure traces to disk, so scrub them first. This is
 * deliberately conservative: it prefers over-redacting to leaking a credential
 * into a SQLite file that later gets exported into a shared skill.
 */
/** Values that look like credentials, replaced by a fixed placeholder. */
const PATTERNS = [
    // Authorization: Bearer xxx / Basic xxx
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{12,}/gi, '$1 <redacted>'],
    // Common key=value secret assignments.
    [
        /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi,
        '$1=<redacted>',
    ],
    // Provider-shaped keys.
    [/\bsk-[A-Za-z0-9\-_]{16,}/g, '<redacted-key>'],
    [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '<redacted-token>'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
    // More provider token shapes (npm granular tokens, fine-grained GitHub PATs,
    // GitLab PATs, Google API keys, Slack tokens, Stripe live keys).
    [/\bnpm_[A-Za-z0-9]{20,}/g, '<redacted-token>'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<redacted-token>'],
    [/\bglpat-[A-Za-z0-9\-_]{16,}/g, '<redacted-token>'],
    [/\bAIza[0-9A-Za-z\-_]{30,}/g, '<redacted-api-key>'],
    [/\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, '<redacted-token>'],
    [/\bsk_live_[A-Za-z0-9]{16,}/g, '<redacted-key>'],
    // URLs with inline credentials: scheme://user:pass@host
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
    // Long base64/hex blobs (JWTs, signatures, hashes).
    [/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '<redacted-jwt>'],
];
export function redact(input) {
    let out = input;
    for (const [re, replacement] of PATTERNS)
        out = out.replace(re, replacement);
    return out;
}
/** Redact then clamp, so no single trace can bloat the database. */
export function redactAndClamp(input, max = 1200) {
    let text;
    if (typeof input === 'string')
        text = input;
    else {
        try {
            text = JSON.stringify(input);
        }
        catch {
            text = String(input);
        }
    }
    if (text === undefined)
        text = '';
    const clean = redact(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= max)
        return clean;
    if (max >= 120) {
        const errAt = clean.lastIndexOf(' error=');
        const resAt = clean.lastIndexOf(' result=');
        const markerAt = Math.max(errAt, resAt);
        if (markerAt > 16) {
            const tailBudget = Math.max(240, Math.floor(max * 0.4));
            const rawTail = clean.slice(markerAt + 1);
            const tail = rawTail.length > tailBudget ? `${rawTail.slice(0, tailBudget)}…` : rawTail;
            const headBudget = Math.max(16, max - tail.length - 2);
            return `${clean.slice(0, headBudget)}… ${tail}`;
        }
    }
    return `${clean.slice(0, max)}…`;
}
