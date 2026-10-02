import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  titleFromMessage,
  type AttachmentRef,
  type ChatMessage,
  type ChatUsage,
  type Conversation,
  type MessageStatus,
  type ProviderId,
  type UpdateConversationRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

const DAY_MS = 24 * 3600_000;
const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);

function toConversation(snap: DocumentSnapshot): Conversation {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    title: d.title ?? '',
    pinned: d.pinned === true,
    lastModelId: d.lastModelId ?? null,
    messageCount: d.messageCount ?? 0,
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
    expireAt: iso(d.expireAt),
  };
}

function toMessage(snap: DocumentSnapshot): ChatMessage {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    role: d.role,
    content: d.content ?? '',
    status: d.status,
    modelId: d.modelId ?? null,
    providerId: d.providerId ?? null,
    usage: d.usage ?? null,
    cost: d.cost ?? null,
    stopReason: d.stopReason ?? null,
    error: d.error ?? null,
    latencyMs: d.latencyMs ?? null,
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
  };
}

/** A turn the model sees again: text plus the files attached to user messages. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments: AttachmentRef[];
}

// Failed answers and placeholders are not part of the conversation the model sees.
const toHistory = (messages: ChatMessage[]): HistoryMessage[] =>
  messages
    .filter((m) => m.content && (m.role === 'user' || m.status !== 'error'))
    .map((m) => ({ role: m.role, content: m.content, attachments: m.attachments }));

export interface StartTurnInput {
  ownerUid: string;
  /** null = start a new conversation titled after the message. */
  conversationId: string | null;
  userText: string;
  /** Files attached to the user message. */
  attachments?: AttachmentRef[];
  modelId: string;
  providerId: ProviderId;
  /** Content is deleted automatically this many days after it was written (decision D8). */
  retentionDays: number;
}

export interface StartedTurn {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  /** Earlier messages of the conversation, oldest first (without this turn). */
  history: HistoryMessage[];
}

export interface FinishTurnInput {
  content: string;
  status: Exclude<MessageStatus, 'streaming'>;
  usage: ChatUsage | null;
  cost: number | null;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  latencyMs: number;
  /** The model that really answered, when a fallback replaced the routed one. */
  modelId?: string;
  providerId?: ProviderId;
}

/**
 * conversations/{id} and conversations/{id}/messages/{mid} (spec 9). Only the owner can
 * read a conversation; nobody else, admins included, gets its content through the API.
 */
export class ConversationStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.conversations);
  }
  private messages(id: string) {
    return this.col().doc(id).collection('messages');
  }

  /** The conversation if it exists and belongs to `ownerUid`, else null. */
  async get(id: string, ownerUid: string): Promise<Conversation | null> {
    const snap = await this.col().doc(id).get();
    if (!snap.exists || snap.get('ownerUid') !== ownerUid) return null;
    return toConversation(snap);
  }

  /** Most recently updated first; needs the (ownerUid, updatedAt desc) index. */
  async list(ownerUid: string, limit = 100): Promise<Conversation[]> {
    const snap = await this.col()
      .where('ownerUid', '==', ownerUid)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(toConversation);
  }

  async create(ownerUid: string, title: string, retentionDays: number): Promise<Conversation> {
    const now = Timestamp.now();
    const ref = this.col().doc();
    await ref.create({
      ownerUid,
      title,
      pinned: false,
      lastModelId: null,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      expireAt: Timestamp.fromMillis(now.toMillis() + retentionDays * DAY_MS),
    });
    return toConversation(await ref.get());
  }

  async update(
    id: string,
    ownerUid: string,
    patch: UpdateConversationRequest,
  ): Promise<Conversation | null> {
    const ref = this.col().doc(id);
    const ok = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('ownerUid') !== ownerUid) return false;
      tx.update(ref, patch);
      return true;
    });
    return ok ? toConversation(await ref.get()) : null;
  }

  /** Deletes the conversation and all its messages (the cost ledger is kept). */
  async delete(id: string, ownerUid: string): Promise<boolean> {
    const ref = this.col().doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.get('ownerUid') !== ownerUid) return false;
    await this.db.recursiveDelete(ref);
    return true;
  }

  async listMessages(id: string, limit = 500): Promise<ChatMessage[]> {
    const snap = await this.messages(id).orderBy('seq', 'desc').limit(limit).get();
    return snap.docs.map(toMessage).reverse();
  }

  /** Earlier turns the model should see (null when the conversation is not the caller's). */
  async history(id: string, ownerUid: string, limit = 50): Promise<HistoryMessage[] | null> {
    const snap = await this.col().doc(id).get();
    if (!snap.exists || snap.get('ownerUid') !== ownerUid) return null;
    const earlier = await this.messages(id).orderBy('seq', 'desc').limit(limit).get();
    return toHistory(earlier.docs.map(toMessage).reverse());
  }

  /**
   * Writes the user message and an empty assistant message ("streaming") in one
   * transaction, creating the conversation when needed. Returns the earlier history
   * so the gateway can build the provider request. Null when the conversation is not
   * the caller's.
   */
  async startTurn(input: StartTurnInput, historyLimit = 50): Promise<StartedTurn | null> {
    const now = Timestamp.now();
    const expireAt = Timestamp.fromMillis(now.toMillis() + input.retentionDays * DAY_MS);
    const ref = input.conversationId ? this.col().doc(input.conversationId) : this.col().doc();
    const userRef = this.messages(ref.id).doc();
    const assistantRef = this.messages(ref.id).doc();

    return this.db.runTransaction(async (tx) => {
      let seq = 0;
      let history: StartedTurn['history'] = [];
      if (input.conversationId) {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.get('ownerUid') !== input.ownerUid) return null;
        seq = (snap.get('messageCount') as number | undefined) ?? 0;
        const earlier = await tx.get(
          this.messages(ref.id).orderBy('seq', 'desc').limit(historyLimit),
        );
        history = toHistory(earlier.docs.map(toMessage).reverse());
        tx.update(ref, {
          updatedAt: now,
          expireAt,
          lastModelId: input.modelId,
          messageCount: FieldValue.increment(2),
        });
      } else {
        tx.create(ref, {
          ownerUid: input.ownerUid,
          title: titleFromMessage(input.userText),
          pinned: false,
          lastModelId: input.modelId,
          messageCount: 2,
          createdAt: now,
          updatedAt: now,
          expireAt,
        });
      }
      const base = {
        createdAt: now,
        expireAt,
        usage: null,
        cost: null,
        stopReason: null,
        error: null,
      };
      tx.create(userRef, {
        ...base,
        seq,
        role: 'user',
        content: input.userText,
        attachments: input.attachments ?? [],
        status: 'complete',
        modelId: null,
        providerId: null,
        latencyMs: null,
      });
      tx.create(assistantRef, {
        ...base,
        seq: seq + 1,
        role: 'assistant',
        content: '',
        status: 'streaming',
        modelId: input.modelId,
        providerId: input.providerId,
        latencyMs: null,
      });
      return {
        conversationId: ref.id,
        userMessageId: userRef.id,
        messageId: assistantRef.id,
        history,
      };
    });
  }

  /** Stores the final answer (complete, cancelled with partial text, or error). */
  async finishTurn(conversationId: string, messageId: string, result: FinishTurnInput) {
    const batch = this.db.batch();
    batch.update(this.messages(conversationId).doc(messageId), { ...result });
    batch.update(this.col().doc(conversationId), { updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
}
