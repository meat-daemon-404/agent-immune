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

export interface LlmConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  allowPrivate: boolean;
  timeoutMs: number;
  /** Omitted unless configured: some reasoning models reject max_tokens. */
  maxTokens?: number;
  /** Omitted unless configured: reasoning models reject it. */
  temperature?: number;
}

/** Read configuration from the environment; null when no model is configured. */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const endpoint = env.IMMUNE_LLM_BASE_URL?.trim();
  const model = env.IMMUNE_LLM_MODEL?.trim();
  if (!endpoint || !model) return null;

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
function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateV4([a = 0, b = 0]: number[]): boolean {
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
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
export function assertSafeEndpoint(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid endpoint URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`endpoint must use http or https, got ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('endpoint has no host');

  if (allowPrivate) return url;

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
    if (isPrivateV6(host)) throw new Error(`endpoint host is a private or reserved address: ${host}`);
  }

  return url;
}

/** One chat completion. Throws on transport error, timeout, or non-2xx. */
export async function chat(
  cfg: LlmConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = assertSafeEndpoint(cfg.endpoint, cfg.allowPrivate);
  const url = new URL(
    base.pathname.endsWith('/chat/completions')
      ? base.toString()
      : `${base.toString().replace(/\/$/, '')}/chat/completions`,
  );

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const body = JSON.stringify({
    model: cfg.model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.maxTokens !== undefined ? { max_tokens: cfg.maxTokens } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  // Rate-limited free/gateway channels answer 4xx with a rate-limit body.
  // One spaced retry absorbs the common case; the caller's AbortSignal still
  // bounds the total wait, and anything else fails through to the caller.
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: combined,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      // Free/gateway channels rate-limit in bursts and some answer 400 for it.
      // Retry any non-auth 4xx once after a spaced wait; 401/403 are permanent.
      const retryable =
        response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403;
      if (retryable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      throw new Error(`model endpoint returned ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: unknown; code?: unknown; type?: unknown };
    };
    // Some gateways answer HTTP 200 with an error body; a rate-limit verdict
    // there gets the same single retry as a 4xx.
    const bodyErr = data.error as { message?: unknown; type?: unknown } | undefined;
    if (bodyErr !== undefined) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      throw new Error(
        `model endpoint error: ${String(bodyErr.type ?? 'error')}: ${String(bodyErr.message ?? '').slice(0, 160)}`,
      );
    }

    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }
}
