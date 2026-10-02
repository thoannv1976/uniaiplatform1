import { z } from 'zod';
import { attachmentRefSchema, fileIdSchema, MAX_FILES_PER_MESSAGE } from './files.js';
import { MODEL_TIERS, modelIdSchema, PROVIDER_IDS } from './models.js';

/**
 * Chat API (spec 8.3, 8.4): POST /api/ai/chat streams Server-Sent Events; conversations
 * and messages are read through /api/conversations. Money is integer micro-USD.
 */

export const CHAT_MODEL_AUTO = 'auto';
export const MAX_MESSAGE_CHARS = 32_000;

/** Default instructions for every conversation (Vietnamese answers unless asked otherwise). */
export const DEFAULT_SYSTEM_PROMPT =
  'Bạn là trợ lý AI của Trường Đại học Ngoại thương, hỗ trợ cán bộ và giảng viên. ' +
  'Trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu ngôn ngữ khác. ' +
  'Trình bày rõ ràng, dùng Markdown khi phù hợp. Nếu không chắc chắn, hãy nói rõ.';

/** Firestore auto ids: 20 alphanumeric characters. */
export const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,64}$/, 'Mã hội thoại không hợp lệ');

export const chatRequestSchema = z
  .object({
    /** Omitted or null = start a new conversation. */
    conversationId: conversationIdSchema.nullable().optional(),
    message: z
      .string()
      .trim()
      .min(1, 'Tin nhắn không được trống')
      .max(MAX_MESSAGE_CHARS, `Tin nhắn tối đa ${MAX_MESSAGE_CHARS.toLocaleString('vi-VN')} ký tự`),
    /** "auto" (default) lets the router choose; otherwise a registry model id. */
    model: z.union([z.literal(CHAT_MODEL_AUTO), modelIdSchema]).default(CHAT_MODEL_AUTO),
    /** Uploaded files (POST /api/files) to attach to this message. */
    fileIds: z
      .array(fileIdSchema)
      .max(MAX_FILES_PER_MESSAGE, `Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi tin nhắn`)
      .optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const MESSAGE_STATUSES = ['streaming', 'complete', 'cancelled', 'error'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
});
export type ChatUsage = z.infer<typeof tokenUsageSchema>;

const errorInfoSchema = z.object({ code: z.string(), message: z.string() });

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(MESSAGE_STATUSES),
  modelId: z.string().nullable(),
  providerId: z.enum(PROVIDER_IDS).nullable(),
  usage: tokenUsageSchema.nullable(),
  /** micro-USD; null for user messages and unfinished answers. */
  cost: z.number().int().nullable(),
  stopReason: z.string().nullable(),
  error: errorInfoSchema.nullable(),
  latencyMs: z.number().int().nullable(),
  /** Files attached to a user message. */
  attachments: z.array(attachmentRefSchema),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  lastModelId: z.string().nullable(),
  messageCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When the content is deleted automatically (retention policy, decision D8). */
  expireAt: z.string().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
});
export const conversationDetailResponseSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailResponseSchema>;

const titleSchema = z.string().trim().min(1, 'Tiêu đề không được trống').max(200);

export const createConversationRequestSchema = z.object({ title: titleSchema.optional() }).strict();
export const updateConversationRequestSchema = z
  .object({ title: titleSchema.optional(), pinned: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

/** A model the current user may pick in the chat (GET /api/ai/models). */
export const chatModelOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  providerId: z.enum(PROVIDER_IDS),
  tier: z.enum(MODEL_TIERS),
  capabilities: z.array(z.string()),
});
export type ChatModelOption = z.infer<typeof chatModelOptionSchema>;
export const chatModelListResponseSchema = z.object({ models: z.array(chatModelOptionSchema) });

/** Title for a new conversation: the first line of the first message, shortened. */
export function titleFromMessage(message: string, max = 60): string {
  const line = message.trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ') ?? '';
  if (!line) return 'Hội thoại mới';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// ---------------------------------------------------------------------------
// Server-Sent Events of POST /api/ai/chat. Each event is
//   event: <type>\ndata: <JSON with the same "type">\n\n

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    conversationId: z.string(),
    userMessageId: z.string(),
    messageId: z.string(),
    model: z.object({
      id: z.string(),
      displayName: z.string(),
      providerId: z.enum(PROVIDER_IDS),
      tier: z.enum(MODEL_TIERS),
    }),
    /** Why this model was chosen (shown to the user, stored in the ledger). */
    routeReason: z.string(),
  }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    messageId: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    stopReason: z.string().nullable(),
    usage: tokenUsageSchema.nullable(),
    cost: z.number().int().nullable(),
    latencyMs: z.number().int(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/** Serializes one event for the wire. */
export function formatSseEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Incremental SSE parser: feed it decoded text as it arrives; it calls `onEvent` for each
 * complete, valid event. Comments (heartbeats) and unknown events are ignored.
 */
export function createSseParser(onEvent: (event: ChatStreamEvent) => void) {
  let buffer = '';
  const flush = (block: string) => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = chatStreamEventSchema.safeParse(json);
    if (parsed.success) onEvent(parsed.data);
  };
  return {
    push(text: string) {
      buffer += text.replace(/\r\n?/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        flush(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    },
    end() {
      if (buffer.trim()) flush(buffer);
      buffer = '';
    },
  };
}
