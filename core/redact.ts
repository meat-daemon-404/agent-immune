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
  [/\b(Bearer|Basic|Token)\s+(?!<redacted)[A-Za-z0-9\-._~+/=]{12,}/gi, '$1 <redacted>'],
  // Provider-shaped keys (matched before generic key=value & URL query params
  // so specific placeholder labels stay intact).
  [/\bsk-[A-Za-z0-9\-_]{16,}/g, '<redacted-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '<redacted-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  // More provider token shapes (npm granular tokens, fine-grained GitHub PATs,
  // GitLab PATs, Google API keys, Slack tokens, Stripe live/test keys,
  // Hugging Face, PyPI, SendGrid, Docker Hub).
  [/\bnpm_[A-Za-z0-9]{20,}/g, '<redacted-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<redacted-token>'],
  [/\bglpat-[A-Za-z0-9\-_]{16,}/g, '<redacted-token>'],
  [/\bAIza[0-9A-Za-z\-_]{30,}/g, '<redacted-api-key>'],
  [/\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, '<redacted-token>'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '<redacted-key>'],
  [/\bhf_[A-Za-z0-9]{20,}/g, '<redacted-token>'],
  [/\bpypi-[A-Za-z0-9\-_]{20,}/g, '<redacted-token>'],
  [/\bSG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}/g, '<redacted-token>'],
  [/\bdckr_pat_[A-Za-z0-9\-_]{16,}/g, '<redacted-token>'],
  // PEM private key blocks (multi-line or clamped single-line tail) & SSH keys.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<redacted-private-key>'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\r\n]*/g, '<redacted-private-key>'],
  [/\bssh-(?:rsa|ed25519|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]{24,}(?:\s+\S+)?/g, '<redacted-ssh-key>'],
  // URLs with inline credentials: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)(?!<redacted>)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // Long base64/hex blobs (JWTs, signatures, hashes).
  [/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '<redacted-jwt>'],
  // .npmrc registry authToken lines and standalone _authToken assignments.
  [/(\/\/[^\s:=]+:_auth(?:Token)?\s*=\s*)["']?(?!<redacted)([^\s"',;]{6,})["']?/gi, '$1<redacted>'],
  [/\b(_authToken\s*[:=]\s*)["']?(?!<redacted)([^\s"',;]{6,})["']?/gi, '$1<redacted>'],
  // URL query-string credentials / signed URL parameters.
  [
    /([?&](?:access_token|auth_token|refresh_token|id_token|api_key|apikey|client_secret|token|secret|password|passwd|credential|private_key|signature|sig|X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|X-Goog-Signature)=)(?!<redacted)([^&#\s"']+)/gi,
    '$1<redacted>',
  ],
  // HTTP secret headers (curl -H, raw request headers).
  [
    /\b(X-Api-Key|X-Auth-Token|Private-Token|X-GitLab-Token|X-Hub-Signature(?:-256)?|Proxy-Authorization)(\s*:\s*)(?!<redacted)([^\s"',;\r\n]{8,})/gi,
    '$1$2<redacted>',
  ],
  [/\b(Cookie|Set-Cookie)(\s*:\s*)(?!<redacted)([^\r\n"';]*=[^\r\n"']{6,})/gi, '$1$2<redacted>'],
  // JSON-quoted and nested-escaped JSON key/value secret pairs (preserving valid JSON).
  [
    /"([A-Za-z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?TOKEN)[A-Za-z0-9_.-]*)"(\s*:\s*)"(?!<redacted)(?:\\.|[^"\\]){8,}"/gi,
    '"$1"$2"<redacted>"',
  ],
  [
    /\\"([A-Za-z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?TOKEN)[A-Za-z0-9_.-]*)\\"(\s*:\s*)\\"(?!<redacted)[^"\\]{8,}\\"/gi,
    '\\"$1\\"$2\\"<redacted>\\"',
  ],
  // Common key=value secret assignments.
  [
    /\b([A-Za-z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?TOKEN)[A-Za-z0-9_]*)\s*[:=]\s*["']?(?!<redacted)([^\s"',;]{8,})["']?/gi,
    '$1=<redacted>',
  ],
];

const WIN_USER_HOME = /([A-Za-z]:)(\\\\|\\|\/)Users\2(?!<user>(?:[\\/]|$))[^\\/\s"'`<>|]{1,64}/gi;
const MAC_USER_HOME = /(?<![A-Za-z0-9_.\/-])(\/Users\/)(?!<user>(?:\/|$))[^\/\s"'`<>|]{1,64}/g;
const LINUX_USER_HOME = /(?<![A-Za-z0-9_.\/-])(\/home\/)(?!<user>(?:\/|$))[^\/\s"'`<>|]{1,64}/g;
const EMAIL_ADDRESS =
  /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.(?!(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|png|jpg|jpeg|webp|svg|md|yml|yaml|lock|txt|log)\b)[A-Za-z]{2,12}\b/gi;

export function redact(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Mask OS user account segments inside home directory paths while keeping
 * project-relative paths intact for local self-noise and pairing logic.
 */
export function maskHomePaths(input: string): string {
  return input
    .replace(WIN_USER_HOME, '$1$2Users$2<user>')
    .replace(MAC_USER_HOME, '$1<user>')
    .replace(LINUX_USER_HOME, '$1<user>');
}

/** Replace email addresses with a fixed placeholder on outbound/share paths. */
export function redactEmails(input: string): string {
  return input.replace(EMAIL_ADDRESS, '<redacted-email>');
}

/** Sanitize text before sending it to an external model or shared surface. */
export function redactOutbound(input: string): string {
  return redactEmails(maskHomePaths(redact(input)));
}

/** Strip credentials and query parameters from a URL before logging it. */
export function redactUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
  } catch {
    // Fall through to pattern redaction when the input is malformed.
  }
  return redactOutbound(raw);
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
  if (clean.length <= max) return clean;
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
