import { describe, expect, it } from 'vitest';
import { createProvider } from './factory.js';
import { MockProvider } from './mock.js';
import {
  anthropicFixtures,
  geminiFixtures,
  LEAKED_KEY,
  openaiFixtures,
  type Case,
  type Fixtures,
} from './testing/fixtures.js';
import { fakeGoogleAuth, replay, type CapturedRequest } from './testing/recorded-http.js';
import type { ChatChunk, LLMProvider, NormalizedChatRequest } from './types.js';

const request: NormalizedChatRequest = {
  model: 'test-model@20251001',
  messages: [
    { role: 'system', content: 'Bạn là trợ lý của Trường.' },
    { role: 'user', content: 'Chào bạn' },
    { role: 'assistant', content: 'Chào thầy cô.' },
    { role: 'user', content: 'Xin chào' },
  ],
  maxOutputTokens: 256,
  reasoningEffort: 'low',
};

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}
const textOf = (chunks: ChatChunk[]) =>
  chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('');

/** Invariants every adapter must keep, whatever the provider sent. */
function expectContract(chunks: ChatChunk[]) {
  const last = chunks.at(-1);
  expect(last && (last.type === 'done' || last.type === 'error')).toBe(true);
  const usages = chunks.filter((c) => c.type === 'usage');
  expect(usages.length).toBeLessThanOrEqual(1);
  if (last?.type === 'done') {
    expect(chunks.at(-2)?.type).toBe('usage');
  }
  for (const u of usages) {
    if (u.type !== 'usage') continue;
    for (const n of [u.inputTokens, u.outputTokens, u.cachedInputTokens]) {
      expect(Number.isSafeInteger(n) && n >= 0).toBe(true);
    }
  }
  expect(chunks.filter((c) => c.type === 'done' || c.type === 'error')).toHaveLength(1);
}

interface AdapterCase {
  name: string;
  fixtures: Fixtures;
  make: (fetchImpl: typeof fetch) => LLMProvider;
  checkRequest: (req: CapturedRequest) => void;
}

const project = 'uniaiplatform1';
const adapters: AdapterCase[] = [
  {
    name: 'OpenAI (direct)',
    fixtures: openaiFixtures,
    make: (f) =>
      createProvider({ id: 'openai', transport: 'direct', apiKey: 'sk-test-key', fetch: f }),
    checkRequest: (r) => {
      expect(r.url).toBe('https://api.openai.com/v1/responses');
      expect(r.headers.get('authorization')).toBe('Bearer sk-test-key');
      expect(r.body).toMatchObject({
        model: 'test-model@20251001',
        instructions: 'Bạn là trợ lý của Trường.',
        input: [
          { role: 'user', content: 'Chào bạn' },
          { role: 'assistant', content: 'Chào thầy cô.' },
          { role: 'user', content: 'Xin chào' },
        ],
        max_output_tokens: 256,
        reasoning: { effort: 'low' },
        store: false,
        stream: true,
      });
    },
  },
  {
    name: 'Anthropic (direct)',
    fixtures: anthropicFixtures,
    make: (f) =>
      createProvider({ id: 'anthropic', transport: 'direct', apiKey: 'sk-ant-test', fetch: f }),
    checkRequest: (r) => {
      expect(r.url).toBe('https://api.anthropic.com/v1/messages');
      expect(r.headers.get('x-api-key')).toBe('sk-ant-test');
      expect(r.body).toMatchObject({
        // Vertex-style snapshot id converted for the Claude API.
        model: 'test-model-20251001',
        system: 'Bạn là trợ lý của Trường.',
        max_tokens: 256,
        output_config: { effort: 'low' },
        stream: true,
      });
      expect(r.body?.messages).toHaveLength(3);
    },
  },
  {
    name: 'Anthropic (Vertex AI)',
    fixtures: anthropicFixtures,
    make: (f) =>
      createProvider({
        id: 'anthropic',
        transport: 'vertex',
        project,
        location: 'global',
        authClient: fakeGoogleAuth(),
        fetch: f,
      }),
    checkRequest: (r) => {
      expect(r.url).toBe(
        `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/anthropic/models/test-model@20251001:streamRawPredict`,
      );
      expect(r.headers.get('authorization')).toBe('Bearer ya29.test-token');
      expect(r.body).toMatchObject({ anthropic_version: 'vertex-2023-10-16', max_tokens: 256 });
      expect(r.body).not.toHaveProperty('model');
    },
  },
  {
    name: 'Gemini (Vertex AI)',
    fixtures: geminiFixtures,
    make: (f) =>
      createProvider({
        id: 'gemini',
        transport: 'vertex',
        project,
        location: 'global',
        authClient: fakeGoogleAuth(),
        fetch: f,
      }),
    checkRequest: (r) => {
      expect(r.url).toContain(
        `/projects/${project}/locations/global/publishers/google/models/test-model@20251001:streamGenerateContent?alt=sse`,
      );
      expect(r.headers.get('authorization')).toBe('Bearer ya29.test-token');
      expect(r.body).toMatchObject({
        contents: [
          { role: 'user', parts: [{ text: 'Chào bạn' }] },
          { role: 'model', parts: [{ text: 'Chào thầy cô.' }] },
          { role: 'user', parts: [{ text: 'Xin chào' }] },
        ],
        systemInstruction: { parts: [{ text: 'Bạn là trợ lý của Trường.' }] },
        generationConfig: { maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'LOW' } },
      });
    },
  },
  {
    name: 'Gemini (direct)',
    fixtures: geminiFixtures,
    make: (f) =>
      createProvider({ id: 'gemini', transport: 'direct', apiKey: 'AIza-test-key', fetch: f }),
    checkRequest: (r) => {
      expect(r.url).toContain(
        'https://generativelanguage.googleapis.com/v1beta/models/test-model@20251001:streamGenerateContent?alt=sse',
      );
      expect(r.headers.get('x-goog-api-key')).toBe('AIza-test-key');
    },
  },
];

const run = async (a: AdapterCase, c: Case) => {
  const http = replay(a.fixtures[c]);
  const chunks = await collect(a.make(http.fetch).stream(request));
  expectContract(chunks);
  return { chunks, http };
};

describe.each(adapters)('$name adapter contract', (a) => {
  it('maps the request and normalizes text, usage and stop reason', async () => {
    const { chunks, http } = await run(a, 'ok');
    expect(http.requests).toHaveLength(1);
    a.checkRequest(http.requests[0]!);
    expect(textOf(chunks)).toBe('Xin chào thầy cô!');
    expect(chunks.slice(-2)).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 6, cachedInputTokens: 8 },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('sends attached images in the provider format', async () => {
    const http = replay(a.fixtures.ok);
    const withImage: NormalizedChatRequest = {
      ...request,
      messages: [
        ...request.messages.slice(0, -1),
        {
          role: 'user',
          content: 'Ảnh này là gì?',
          images: [{ mime: 'image/png', data: 'iVBORw0K' }],
        },
      ],
    };
    expectContract(await collect(a.make(http.fetch).stream(withImage)));
    const body = JSON.stringify(http.requests[0]!.body);
    expect(body).toContain('iVBORw0K');
    expect(body).toContain('Ảnh này là gì?');
    expect(body).toMatch(/"input_image"|"type":"image"|"inlineData"/);
  });

  it('reports max_tokens', async () => {
    const { chunks } = await run(a, 'maxTokens');
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('reports refusals so the gateway can fall back', async () => {
    const { chunks } = await run(a, 'refusal');
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it.each([
    ['rateLimited', 'rate_limited', true],
    ['serverError', 'unavailable', true],
    ['unauthorized', 'auth', false],
  ] as const)('normalizes %s errors', async (c, code, retryable) => {
    const { chunks } = await run(a, c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error', code, retryable });
    const message = chunks[0]?.type === 'error' ? chunks[0].message : '';
    expect(message).not.toContain(LEAKED_KEY);
    expect(message).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });

  it('settles usage when the caller cancels mid-stream', async () => {
    const body = a.fixtures.ok.body;
    // Stop right after the first text event; only an abort ends the response.
    const firstText = body.indexOf('Xin chào');
    const cut = new TextEncoder().encode(body.slice(0, body.indexOf('\n\n', firstText) + 2)).length;
    const http = replay(a.fixtures.ok, { hangAfterBytes: cut });
    const controller = new AbortController();
    const chunks: ChatChunk[] = [];
    for await (const c of a.make(http.fetch).stream(request, controller.signal)) {
      chunks.push(c);
      if (c.type === 'text') controller.abort();
    }
    expectContract(chunks);
    expect(textOf(chunks)).toBe('Xin chào');
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
  });
});

describe('Mock adapter contract', () => {
  it('mentions attached images in its echo', async () => {
    const chunks = await collect(
      new MockProvider().stream({
        ...request,
        messages: [{ role: 'user', content: 'Xem', images: [{ mime: 'image/png', data: 'x' }] }],
      }),
    );
    expect(textOf(chunks)).toBe('[mock:test-model@20251001] [1 ảnh] Xem');
  });

  it('keeps the same invariants', async () => {
    expectContract(await collect(new MockProvider().stream(request)));
    expectContract(await collect(new MockProvider({ failAfterWords: 2 }).stream(request)));
    expectContract(
      await collect(
        new MockProvider({
          failWith: { code: 'rate_limited', message: '429', retryable: true },
        }).stream(request),
      ),
    );
  });
});

describe('createProvider', () => {
  it('refuses the direct transport without a key and OpenAI over Vertex AI', () => {
    expect(() => createProvider({ id: 'openai', transport: 'direct' })).toThrow(/API key/);
    expect(() =>
      createProvider({ id: 'openai', transport: 'vertex', project, location: 'global' }),
    ).toThrow(/Vertex AI/);
    expect(() => createProvider({ id: 'gemini', transport: 'vertex' })).toThrow(/GCP project/);
  });
});
