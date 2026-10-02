import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_KEY_PATTERN,
  platformChatRequestSchema,
  updateAppClientRequestSchema,
} from './platform.js';
import { buildPlatformOpenApi } from './platform-openapi.js';

describe('Platform API schemas', () => {
  it('accepts a conversation ending with the user, with defaults', () => {
    const req = platformChatRequestSchema.parse({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý của LMS' },
        { role: 'user', content: 'Tóm tắt bài 1' },
      ],
    });
    expect(req).toMatchObject({ model: 'auto', stream: false });
    expect(
      platformChatRequestSchema.safeParse({ messages: [{ role: 'assistant', content: 'x' }] })
        .success,
    ).toBe(false);
    expect(platformChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(
      platformChatRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'x' }],
        reference: 'có dấu',
      }).success,
    ).toBe(false);
    expect(
      platformChatRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'x' }],
        conversationId: 'c1',
      }).success,
    ).toBe(false);
    expect(updateAppClientRequestSchema.safeParse({}).success).toBe(false);
  });

  it('recognises the key format only', () => {
    const id = 'A'.repeat(20);
    const secret = 'b'.repeat(43);
    expect(APP_KEY_PATTERN.test(`uak_${id}_${secret}`)).toBe(true);
    expect(APP_KEY_PATTERN.test(`uak_${id}_${secret}x`)).toBe(false);
    expect(APP_KEY_PATTERN.test(`sk_${id}_${secret}`)).toBe(false);
  });
});

describe('Platform OpenAPI', () => {
  it('describes the three endpoints and matches docs/platform/openapi.json', () => {
    const doc = buildPlatformOpenApi();
    expect(Object.keys(doc.paths as object)).toEqual([
      '/api/platform/v1/chat',
      '/api/platform/v1/models',
      '/api/platform/v1/usage',
    ]);
    const schemas = (doc.components as { schemas: Record<string, { required?: string[] }> })
      .schemas;
    expect(schemas.ChatRequest?.required).toEqual(['messages']);
    const committed = readFileSync(
      new URL('../../../docs/platform/openapi.json', import.meta.url),
      'utf8',
    );
    // Regenerate with: pnpm --filter @uniai/shared openapi
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
