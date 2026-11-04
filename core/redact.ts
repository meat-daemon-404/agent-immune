/**
 * Redaction helpers.
 *
 * Hook stdin can carry secrets (API keys in a failed curl, tokens in an env
 * dump). We persist failure traces to disk, so scrub them first. This is
 * deliberately conservative: it prefers over-redacting to leaking a credential
 * into a SQLite file that later gets exported into a shared skill.
 */

/** Values that look like credentials, replaced by a fixed placeholder. */
const PATTERNS: Array<[RegExp, string]> = [
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
  // URLs with inline credentials: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // Long base64/hex blobs (JWTs, signatures, hashes).
  [/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '<redacted-jwt>'],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Redact then clamp, so no single trace can bloat the database. */
export function redactAndClamp(input: unknown, max = 1200): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  if (text === undefined) text = '';
  const clean = redact(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
