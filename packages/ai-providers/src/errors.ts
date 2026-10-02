import type { ChatChunk, ProviderErrorCode } from './types.js';

/** Shapes of vendor API keys; matches are replaced before any message leaves an adapter. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_*-]{6,}/g, // OpenAI, Anthropic (sk-ant-…)
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /ya29\.[0-9A-Za-z_.-]+/g, // Google OAuth access tokens
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

/** Removes anything that looks like a credential from text meant for logs or the UI. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, re) => out.replace(re, '[đã ẩn]'), text);
}

type ErrorChunk = Extract<ChatChunk, { type: 'error' }>;

function codeForStatus(status: number): { code: ProviderErrorCode; retryable: boolean } {
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status >= 500) return { code: 'unavailable', retryable: true };
  if (status >= 400) return { code: 'invalid_request', retryable: false };
  return { code: 'unknown', retryable: false };
}

/** True when the error comes from the caller's AbortSignal. */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/** Normalizes an SDK/network error into an `error` chunk without leaking credentials. */
export function toErrorChunk(provider: string, err: unknown): ErrorChunk {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const raw = typeof e.message === 'string' ? e.message : String(err);
  const detail = redactSecrets(raw).replace(/\s+/g, ' ').slice(0, 300);
  if (typeof e.status === 'number' && e.status >= 400) {
    const { code, retryable } = codeForStatus(e.status);
    return {
      type: 'error',
      code,
      retryable,
      status: e.status,
      message: `${provider} trả lỗi HTTP ${e.status}: ${detail}`,
    };
  }
  const name = typeof e.name === 'string' ? e.name : '';
  if (/timeout/i.test(name) || e.code === 'ETIMEDOUT') {
    return {
      type: 'error',
      code: 'timeout',
      retryable: true,
      message: `${provider} quá thời gian chờ`,
    };
  }
  if (/connection|fetch/i.test(name) || /fetch failed|ECONNRESET|ENOTFOUND/i.test(raw)) {
    return {
      type: 'error',
      code: 'unavailable',
      retryable: true,
      message: `Không kết nối được ${provider}: ${detail}`,
    };
  }
  return { type: 'error', code: 'unknown', retryable: false, message: `${provider}: ${detail}` };
}

/** Rough token estimate (≈ 4 characters per token) for when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
