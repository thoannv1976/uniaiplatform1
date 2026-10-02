import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Embedder } from '@uniai/ai-providers';
import type { KnowledgeStore, UserStore } from '@uniai/firestore';
import type { ChatKnowledgeBase, Citation, KnowledgeBase, UserProfile } from '@uniai/shared';
import { USER_STORE } from '../auth/auth.guard.js';
import { EMBEDDER, KNOWLEDGE_STORE } from './tokens.js';

/** Passages fetched per question, before the distance filter and the size budget. */
const TOP_K = 8;
/** Cosine distance above which a passage is considered unrelated. */
const MAX_DISTANCE = 0.85;
/** Knowledge Base admins may consult every base (to check what they loaded). */
const ALL_BASES_ROLES = ['super_admin', 'ai_admin'];

export interface Retrieved {
  citations: Citation[];
  /** Text placed before the question; empty when nothing was requested. */
  context: string;
}

const date = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : null);

/**
 * RAG retrieval (spec 8.9): only bases the user may see (whole university, or a unit on the
 * user's department path) are searched – the ACL is applied before the vector query.
 */
@Injectable()
export class KnowledgeRetrieval {
  constructor(
    @Inject(KNOWLEDGE_STORE) private readonly store: KnowledgeStore,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(USER_STORE) private readonly users: UserStore,
  ) {}

  /** Active bases the user may consult. */
  async visible(profile: UserProfile): Promise<KnowledgeBase[]> {
    const all = (await this.store.listKbs()).filter((k) => k.active);
    if (ALL_BASES_ROLES.includes(profile.role)) return all;
    const path = await this.users.departmentPathOf(profile.uid);
    return all.filter((k) => k.aclScopeId === null || path.includes(k.aclScopeId));
  }

  async options(profile: UserProfile): Promise<ChatKnowledgeBase[]> {
    return (await this.visible(profile)).map(({ id, name, description, documentCount }) => ({
      id,
      name,
      description,
      documentCount,
    }));
  }

  async retrieve(
    profile: UserProfile,
    kbIds: string[],
    question: string,
    maxChars: number,
  ): Promise<Retrieved> {
    const ids = [...new Set(kbIds)];
    if (ids.length === 0) return { citations: [], context: '' };
    const allowed = new Set((await this.visible(profile)).map((k) => k.id));
    if (ids.some((id) => !allowed.has(id))) {
      throw new ForbiddenException('Bạn không có quyền dùng kho tri thức này.');
    }
    const [vector] = await this.embedder.embed([question], 'query');
    const hits = (await this.store.search(ids, vector!, TOP_K)).filter(
      (h) => h.distance <= MAX_DISTANCE,
    );
    const citations: Citation[] = [];
    const blocks: string[] = [];
    let used = 0;
    for (const h of hits) {
      if (used + h.text.length > maxChars && citations.length > 0) break;
      const n = citations.length + 1;
      const meta = [
        `phiên bản ${h.version}`,
        h.effectiveDate ? `hiệu lực ${date(h.effectiveDate)}` : null,
        h.page !== null ? `trang ${h.page}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const text = h.text.slice(0, Math.max(0, maxChars - used));
      blocks.push(`[${n}] ${h.title} (${meta})\n${text}`);
      used += text.length;
      citations.push({
        n,
        kbId: h.kbId,
        documentId: h.documentId,
        title: h.title,
        version: h.version,
        effectiveDate: h.effectiveDate,
        page: h.page,
        snippet: h.text.slice(0, 300),
      });
    }
    const context = citations.length
      ? 'Tài liệu tham khảo từ kho tri thức của Trường. Chỉ dựa vào các đoạn này khi trả lời về quy định; ' +
        'ghi nguồn bằng số trong ngoặc vuông, ví dụ [1]. Nếu các đoạn không đủ thông tin, hãy nói rõ.\n\n' +
        `${blocks.join('\n\n')}\n\n---\nCâu hỏi:`
      : 'Không tìm thấy đoạn liên quan trong kho tri thức đã chọn. Nếu trả lời từ hiểu biết chung, hãy nói rõ ' +
        'không có căn cứ trong văn bản của Trường.\n\n---\nCâu hỏi:';
    return { citations, context };
  }
}
