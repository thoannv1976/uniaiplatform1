import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { ConversationStore } from './conversations.js';
import { clearFirestoreEmulator } from './testing.js';
import { UsageStore } from './usage.js';

const db = getDb();
const store = new ConversationStore(db);
const turn = (conversationId: string | null, text: string, ownerUid = 'u1') =>
  store.startTurn({
    ownerUid,
    conversationId,
    userText: text,
    modelId: 'mock-economy',
    providerId: 'mock',
    retentionDays: 180,
  });
const finish = (
  cid: string,
  mid: string,
  content: string,
  status: 'complete' | 'error' = 'complete',
) =>
  store.finishTurn(cid, mid, {
    content,
    status,
    usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
    cost: 3,
    stopReason: status === 'complete' ? 'end' : null,
    error: status === 'error' ? { code: 'unavailable', message: 'x' } : null,
    latencyMs: 5,
  });

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe('ConversationStore', () => {
  it('starts a conversation titled after the first message, then carries the history', async () => {
    const first = await turn(null, 'Tóm tắt quy chế đào tạo\nchi tiết');
    expect(first?.history).toEqual([]);
    await finish(first!.conversationId, first!.messageId, 'Đây là tóm tắt.');

    const failed = await turn(first!.conversationId, 'Câu hỏi lỗi');
    await finish(first!.conversationId, failed!.messageId, '', 'error');

    const third = await turn(first!.conversationId, 'Câu tiếp theo');
    expect(third?.history).toEqual([
      { role: 'user', content: 'Tóm tắt quy chế đào tạo\nchi tiết', attachments: [] },
      { role: 'assistant', content: 'Đây là tóm tắt.', attachments: [] },
      { role: 'user', content: 'Câu hỏi lỗi', attachments: [] },
    ]);

    const conv = await store.get(first!.conversationId, 'u1');
    expect(conv).toMatchObject({
      title: 'Tóm tắt quy chế đào tạo',
      messageCount: 6,
      lastModelId: 'mock-economy',
    });
    const days = (Date.parse(conv!.expireAt!) - Date.parse(conv!.updatedAt)) / 86_400_000;
    expect(Math.round(days)).toBe(180);

    const messages = await store.listMessages(first!.conversationId);
    expect(messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
      ['user', 'complete'],
      ['assistant', 'error'],
      ['user', 'complete'],
      ['assistant', 'streaming'],
    ]);
  });

  it('keeps conversations private to their owner', async () => {
    const t = await turn(null, 'Bí mật');
    const cid = t!.conversationId;
    expect(await store.get(cid, 'u2')).toBeNull();
    expect(await turn(cid, 'chen ngang', 'u2')).toBeNull();
    expect(await store.update(cid, 'u2', { title: 'x' })).toBeNull();
    expect(await store.delete(cid, 'u2')).toBe(false);
    expect((await store.list('u2')).length).toBe(0);
    expect((await store.list('u1')).map((c) => c.id)).toEqual([cid]);
  });

  it('renames, pins, lists newest first and deletes with all messages', async () => {
    const a = await turn(null, 'A');
    const b = await turn(null, 'B');
    expect((await store.list('u1')).map((c) => c.title)).toEqual(['B', 'A']);
    expect(
      await store.update(a!.conversationId, 'u1', { title: 'Đổi tên', pinned: true }),
    ).toMatchObject({
      title: 'Đổi tên',
      pinned: true,
    });
    expect(await store.delete(b!.conversationId, 'u1')).toBe(true);
    expect(await store.listMessages(b!.conversationId)).toEqual([]);
    expect((await store.list('u1')).map((c) => c.id)).toEqual([a!.conversationId]);
  });
});

describe('UsageStore', () => {
  it('appends committed ledger entries', async () => {
    const usage = new UsageStore(db);
    const now = new Date();
    await usage.record({
      uid: 'u1',
      departmentId: 'KTQT',
      departmentPath: ['FTU', 'KTQT'],
      appClientId: null,
      providerId: 'mock',
      transport: 'direct',
      modelId: 'mock-economy',
      apiModelId: 'mock-economy',
      priceId: 'p1',
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
      costInput: 1,
      costCachedInput: 0,
      costOutput: 10,
      totalCost: 11,
      reservedCost: 0,
      conversationId: 'c1',
      messageId: 'm1',
      routeReason: 'AUTO',
      fallbackFrom: null,
      outcome: 'complete',
      requestTime: now,
      responseTime: now,
      latencyMs: 5,
    });
    const list = await usage.listForUser('u1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'committed', totalCost: 11 });
  });
});
