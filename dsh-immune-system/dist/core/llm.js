/**
 * Minimal OpenAI-compatible client used by the distiller.
 *
 * The endpoint is user-configured, so it is validated before use: only http(s)
 * is allowed and loopback, private, link-local, CGNAT and reserved addresses are
 * refused. That blocks the common SSRF shape where a value smuggled into config
 * (or a poisoned env var) points the agent's outbound request at internal
 * services or cloud metadata endpoints.
 *
 * Local inference servers are also loopback by definition. Set
 * IMMUNE_ALLOW_PRIVATE_ENDPOINT=1 to opt in deliberately; the default is deny.
 */
import { redactOutbound, redactUrl } from './redact.js';
/** Read configuration from the environment; null when no model is configured. */
export function readLlmConfig(env = process.env) {
    const endpoint = env.IMMUNE_LLM_BASE_URL?.trim();
    const model = env.IMMUNE_LLM_MODEL?.trim();
    if (!endpoint || !model)
        return null;
    const timeout = Number(env.IMMUNE_LLM_TIMEOUT_MS ?? '');
    const maxTokens = Number(env.IMMUNE_LLM_MAX_TOKENS ?? '');
    // Reasoning models (SenseNova 6.8, o1-style, most free gateways) reject
    // `temperature`. Omit it unless the operator asks for it explicitly.
    const temperature = Number(env.IMMUNE_LLM_TEMPERATURE ?? '');
    return {
        endpoint,
        apiKey: env.IMMUNE_LLM_API_KEY?.trim() ?? '',
        model,
        allowPrivate: env.IMMUNE_ALLOW_PRIVATE_ENDPOINT === '1',
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20_000,
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
        ...(Number.isFinite(temperature) && temperature >= 0 ? { temperature } : {}),
    };
}
/** Parse an IPv4 literal into octets, or null when it is not one. */
function ipv4Octets(host) {
    const parts = host.split('.');
    if (parts.length !== 4)
        return null;
    const nums = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part))
            return null;
        const n = Number(part);
        if (n > 255)
            return null;
        nums.push(n);
    }
    return nums;
}
function isPrivateV4([a = 0, b = 0]) {
    if (a === 0)
        return true; // "this network"
    if (a === 10)
        return true;
    if (a === 127)
        return true; // loopback
    if (a === 169 && b === 254)
        return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true; // CGNAT
    if (a === 192 && b === 0)
        return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19))
        return true; // benchmarking
    if (a >= 224)
        return true; // multicast and reserved
    return false;
}
function isPrivateV6(host) {
    const h = host.toLowerCase();
    if (h === '::1' || h === '::')
        return true;
    if (h.startsWith('fe80'))
        return true; // link-local
    if (h.startsWith('fc') || h.startsWith('fd'))
        return true; // unique local
    if (h.startsWith('::ffff:')) {
        const mapped = ipv4Octets(h.slice('::ffff:'.length));
        return mapped ? isPrivateV4(mapped) : true;
    }
    return false;
}
/**
 * Validate an endpoint URL, throwing when it is not an acceptable target.
 * Returns the parsed URL so callers do not re-parse.
 */
export function assertSafeEndpoint(raw, allowPrivate = false) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`invalid endpoint URL: ${redactUrl(raw)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`endpoint must use http or https, got ${url.protocol}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host)
        throw new Error('endpoint has no host');
    if (allowPrivate)
        return url;
    if (host === 'localhost' || host.endsWith('.localhost')) {
        throw new Error('endpoint host is loopback (localhost)');
    }
    if (host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error(`endpoint host is a private name: ${host}`);
    }
    const v4 = ipv4Octets(host);
    if (v4 && isPrivateV4(v4)) {
        throw new Error(`endpoint host is a private or reserved address: ${host}`);
    }
    if (!v4 && host.includes(':')) {
        if (isPrivateV6(host))
            throw new Error(`endpoint host is a private or reserved address: ${host}`);
    }
    return url;
}
/**
 * Process-wide rate-limit gate.
 *
 * Public-beta gateways enforce a very low requests-per-minute budget; a burst
 * of calls (a batch drain, a backfill loop) burns it in one go and every
 * subsequent call fails. When a rate limit is observed the gate parks every
 * later call until it expires, so one process self-throttles instead of
 * hammering the endpoint.
 */
let cooldownUntil = 0;
/** Smallest gap between two calls, in ms (IMMUNE_LLM_MIN_INTERVAL_MS). */
export function minCallIntervalMs(env = process.env) {
    const raw = Number(env.IMMUNE_LLM_MIN_INTERVAL_MS ?? '');
    return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}
/** Seconds to wait from a Retry-After header, or null when absent/bad. */
function retryAfterMs(response) {
    const raw = response.headers.get('retry-after');
    if (!raw)
        return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0)
        return Math.min(300_000, seconds * 1000);
    const when = Date.parse(raw);
    return Number.isFinite(when) ? Math.max(0, Math.min(300_000, when - Date.now())) : null;
}
/** True when a response body describes a rate limit, whatever the status. */
function looksRateLimited(status, bodyText) {
    if (status === 429)
        return true;
    return /rate.?limit|exceeds.*(?:tpm|rpm)|too many requests/i.test(bodyText);
}
async function waitForGate(signal) {
    const wait = cooldownUntil - Date.now();
    if (wait <= 0)
        return;
    if (signal?.aborted)
        throw new Error('aborted before rate-limit cooldown ended');
    await new Promise((resolve) => setTimeout(resolve, wait));
}
/** Backoff ladder in ms; overridable for tests via IMMUNE_LLM_BACKOFF_MS. */
function backoffLadder(env = process.env) {
    const raw = env.IMMUNE_LLM_BACKOFF_MS?.trim();
    if (raw) {
        const parsed = raw
            .split(',')
            .map((v) => Number(v.trim()))
            .filter((v) => Number.isFinite(v) && v >= 0);
        if (parsed.length > 0)
            return parsed;
    }
    return [4_000, 12_000, 30_000, 60_000];
}
/** One chat completion. Throws on transport error, timeout, or non-2xx. */
export async function chat(cfg, system, user, signal) {
    const base = assertSafeEndpoint(cfg.endpoint, cfg.allowPrivate);
    const url = new URL(base.pathname.endsWith('/chat/completions')
        ? base.toString()
        : `${base.toString().replace(/\/$/, '')}/chat/completions`);
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey)
        headers.authorization = `Bearer ${cfg.apiKey}`;
    const body = JSON.stringify({
        model: cfg.model,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        ...(cfg.maxTokens !== undefined ? { max_tokens: cfg.maxTokens } : {}),
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    });
    // Up to four attempts with exponential backoff on a rate limit; the
    // caller's AbortSignal still bounds the total wait. 401/403 never retry.
    const backoff = backoffLadder();
    for (let attempt = 0;; attempt += 1) {
        await waitForGate(signal);
        const gap = minCallIntervalMs();
        if (gap > 0)
            await new Promise((resolve) => setTimeout(resolve, gap));
        const timeout = AbortSignal.timeout(cfg.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetch(url, { method: 'POST', headers, body, signal: combined });
        if (response.ok) {
            const data = (await response.json());
            const bodyErr = data.error;
            if (bodyErr !== undefined) {
                const text = `${String(bodyErr.type ?? '')} ${String(bodyErr.message ?? '')}`;
                if (looksRateLimited(0, text) && attempt < backoff.length) {
                    cooldownUntil = Date.now() + (backoff[attempt] ?? 60_000);
                    continue;
                }
                throw new Error(`model endpoint error: ${redactOutbound(text).slice(0, 200)}`);
            }
            const content = data.choices?.[0]?.message?.content;
            return typeof content === 'string' ? content : '';
        }
        const errBody = await response.text().catch(() => '');
        const permanent = response.status === 401 || response.status === 403;
        const rateLimited = looksRateLimited(response.status, errBody);
        const retryable = !permanent && response.status >= 400 && response.status < 500;
        if (rateLimited && attempt < backoff.length) {
            // Honour the server's own hint when it gives one; otherwise back off
            // progressively and park the whole process on the gate.
            const hinted = retryAfterMs(response);
            const wait = hinted ?? backoff[attempt] ?? 60_000;
            cooldownUntil = Date.now() + wait;
            continue;
        }
        if (retryable && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, backoff[attempt] ?? 12_000));
            continue;
        }
        throw new Error(`model endpoint returned ${response.status}: ${redactOutbound(errBody).slice(0, 200)}`);
    }
}
