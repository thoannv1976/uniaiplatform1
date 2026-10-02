import { OAuth2Client } from 'google-auth-library';

/** One recorded HTTP exchange: what the provider answered. */
export interface Recording {
  status: number;
  /** Server-sent events joined as sent on the wire, or a JSON error body. */
  body: string;
  contentType?: string;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/**
 * fetch replacement that replays a recording and captures the request, so adapters run
 * their real SDK code paths in CI without network. With `hangAfterBytes`, the response
 * stops after that many bytes and only ends when the request is aborted.
 */
export function replay(recording: Recording, options: { hangAfterBytes?: number } = {}) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rawBody = init?.body;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
    });
    const bytes = new TextEncoder().encode(recording.body);
    const cut = options.hangAfterBytes ?? bytes.length;
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        if (cut >= bytes.length) {
          controller.close();
          return;
        }
        const abort = () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          controller.error(err);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(stream, {
      status: recording.status,
      headers: {
        'content-type':
          recording.contentType ??
          (recording.status === 200 ? 'text/event-stream' : 'application/json'),
        // Stops the SDKs' automatic retries so error cases stay instant.
        'x-should-retry': 'false',
      },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

/** Google auth client with a fixed, never-expiring test token (no metadata server). */
export function fakeGoogleAuth(): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({ access_token: 'ya29.test-token', expiry_date: Date.now() + 3_600_000 });
  return client;
}

/** Formats events as an SSE body: `event:` lines only when a name is given. */
export function sse(events: { event?: string; data: unknown }[]): string {
  return events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}
