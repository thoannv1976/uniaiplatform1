import { sse, type Recording } from './recorded-http.js';

/**
 * Wire-format recordings for the contract tests, written from each vendor's documented
 * streaming format. Every successful case answers "Xin chào thầy cô!" with the same
 * normalized usage: 12 uncached input, 8 cached input and 6 output tokens.
 */
export type Case = 'ok' | 'maxTokens' | 'refusal' | 'rateLimited' | 'unauthorized' | 'serverError';
export type Fixtures = Record<Case, Recording>;

const ok = (body: string): Recording => ({ status: 200, body });
const json = (status: number, body: unknown): Recording => ({
  status,
  body: JSON.stringify(body),
});
const LEAKED_KEY = 'sk-proj-AbCdEf0123456789XyZ'; // gitleaks:allow (fake key for the redaction tests)

// --- OpenAI Responses API ---------------------------------------------------------------
const oaResponse = (extra: Record<string, unknown>) => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-test',
  output: [],
  usage: {
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
    output_tokens: 6,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 26,
  },
  ...extra,
});
const oaDelta = (seq: number, delta: string, type = 'response.output_text.delta') => ({
  event: type,
  data: {
    type,
    sequence_number: seq,
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta,
    logprobs: [],
  },
});
const oaStart = {
  event: 'response.created',
  data: {
    type: 'response.created',
    sequence_number: 0,
    response: { ...oaResponse({ status: 'in_progress' }), usage: null },
  },
};
const oaEnd = (type: string, response: Record<string, unknown>) => ({
  event: type,
  data: { type, sequence_number: 9, response: oaResponse(response) },
});

export const openaiFixtures: Fixtures = {
  ok: ok(
    sse([
      oaStart,
      oaDelta(1, 'Xin chào'),
      oaDelta(2, ' thầy cô!'),
      oaEnd('response.completed', { status: 'completed', incomplete_details: null }),
    ]),
  ),
  maxTokens: ok(
    sse([
      oaStart,
      oaDelta(1, 'Xin chào'),
      oaDelta(2, ' thầy cô!'),
      oaEnd('response.incomplete', {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ]),
  ),
  refusal: ok(
    sse([
      oaStart,
      oaDelta(1, 'Xin lỗi, tôi không thể', 'response.refusal.delta'),
      oaDelta(2, ' giúp việc này.', 'response.refusal.delta'),
      oaEnd('response.completed', { status: 'completed', incomplete_details: null }),
    ]),
  ),
  rateLimited: json(429, {
    error: {
      message: 'Rate limit reached for requests',
      type: 'requests',
      code: 'rate_limit_exceeded',
    },
  }),
  unauthorized: json(401, {
    error: {
      message: `Incorrect API key provided: ${LEAKED_KEY}.`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  }),
  serverError: json(500, { error: { message: 'The server had an error', type: 'server_error' } }),
};

// --- Anthropic Messages API (Claude API and Vertex AI share the format) -----------------
const anStart = {
  event: 'message_start',
  data: {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 8,
        output_tokens: 1,
      },
    },
  },
};
const anText = (text: string) => ({
  event: 'content_block_delta',
  data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});
const anBody = (stopReason: string, texts: string[]) =>
  sse([
    anStart,
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    { event: 'ping', data: { type: 'ping' } },
    ...texts.map(anText),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 6 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

export const anthropicFixtures: Fixtures = {
  ok: ok(anBody('end_turn', ['Xin chào', ' thầy cô!'])),
  maxTokens: ok(anBody('max_tokens', ['Xin chào', ' thầy cô!'])),
  refusal: ok(anBody('refusal', ['Xin lỗi, tôi không thể giúp việc này.'])),
  rateLimited: json(429, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' },
  }),
  unauthorized: json(401, {
    type: 'error',
    error: { type: 'authentication_error', message: `invalid x-api-key ${LEAKED_KEY}` },
  }),
  serverError: json(529, {
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' },
  }),
};

// --- Gemini streamGenerateContent?alt=sse (Gemini API and Vertex AI) --------------------
const geChunk = (
  text: string,
  extra: Record<string, unknown> = {},
  usage?: Record<string, unknown>,
) => ({
  data: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...extra }],
    usageMetadata: usage ?? { promptTokenCount: 20, totalTokenCount: 20 },
    modelVersion: 'gemini-test',
  },
});
const geUsage = {
  promptTokenCount: 20,
  cachedContentTokenCount: 8,
  candidatesTokenCount: 4,
  thoughtsTokenCount: 2,
  totalTokenCount: 26,
};

export const geminiFixtures: Fixtures = {
  ok: ok(sse([geChunk('Xin chào'), geChunk(' thầy cô!', { finishReason: 'STOP' }, geUsage)])),
  maxTokens: ok(
    sse([geChunk('Xin chào'), geChunk(' thầy cô!', { finishReason: 'MAX_TOKENS' }, geUsage)]),
  ),
  refusal: ok(
    sse([geChunk('Xin lỗi, tôi không thể giúp việc này.', { finishReason: 'SAFETY' }, geUsage)]),
  ),
  rateLimited: json(429, {
    error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' },
  }),
  unauthorized: json(403, {
    error: {
      code: 403,
      message: `API key not valid: AIzaSyA-1234567890abcdefghijklmnop`, // gitleaks:allow (fake key)
      status: 'PERMISSION_DENIED',
    },
  }),
  serverError: json(503, {
    error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' },
  }),
};

export { LEAKED_KEY };
