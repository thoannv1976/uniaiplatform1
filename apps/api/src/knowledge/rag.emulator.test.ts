import type { INestApplication } from '@nestjs/common';
import { MockEmbedder } from '@uniai/ai-providers';
import { chunkText } from '@uniai/documents';
import { getDb, KnowledgeStore } from '@uniai/firestore';
import { createSseParser, type ChatStreamEvent } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { givenUser, resetData, startApp, tokenFor } from '../test/harness.js';
import { KnowledgeRetrieval } from './retrieval.service.js';

let app: INestApplication;
let requests: { messages: { content: string }[] }[];
const http = () => request(app.getHttpServer());
const store = new KnowledgeStore(getDb(), 'production');
const embedder = new MockEmbedder();

/** A small regulation corpus: one document per topic, with five questions each. */
const CORPUS: { title: string; text: string; questions: string[] }[] = [
  {
    title: 'Quy định bảo lưu kết quả học tập',
    text: 'Sinh viên được bảo lưu kết quả học tập khi đi nghĩa vụ quân sự, ốm đau phải điều trị dài ngày hoặc vì lý do cá nhân. Thời gian bảo lưu tối đa hai năm. Hồ sơ bảo lưu gồm đơn xin bảo lưu và giấy tờ chứng minh, nộp tại phòng Quản lý đào tạo.',
    questions: [
      'Sinh viên được bảo lưu kết quả học tập tối đa bao lâu?',
      'Hồ sơ xin bảo lưu gồm những gì?',
      'Đi nghĩa vụ quân sự có được bảo lưu không?',
      'Nộp đơn xin bảo lưu ở đâu?',
      'Ốm đau điều trị dài ngày thì bảo lưu thế nào?',
    ],
  },
  {
    title: 'Quy định học phí',
    text: 'Học phí được tính theo số tín chỉ đăng ký mỗi học kỳ. Sinh viên đóng học phí trong bốn tuần đầu học kỳ qua ngân hàng. Chậm đóng học phí sẽ bị khóa tài khoản đăng ký học phần. Miễn giảm học phí áp dụng cho sinh viên thuộc diện chính sách.',
    questions: [
      'Học phí được tính theo cách nào?',
      'Hạn đóng học phí mỗi học kỳ là khi nào?',
      'Chậm đóng học phí thì bị xử lý ra sao?',
      'Ai được miễn giảm học phí?',
      'Đóng học phí qua kênh nào?',
    ],
  },
  {
    title: 'Quy chế thi và kiểm tra',
    text: 'Sinh viên vắng thi không có lý do chính đáng nhận điểm không. Phúc khảo bài thi nộp đơn trong năm ngày làm việc sau khi công bố điểm. Mang tài liệu vào phòng thi khi không được phép bị đình chỉ thi. Lịch thi công bố trước hai tuần.',
    questions: [
      'Vắng thi không có lý do thì bị gì?',
      'Thời hạn nộp đơn phúc khảo bài thi?',
      'Mang tài liệu vào phòng thi bị xử lý thế nào?',
      'Lịch thi được công bố trước bao lâu?',
      'Muốn phúc khảo điểm thi thì làm sao?',
    ],
  },
  {
    title: 'Quy định chuẩn đầu ra ngoại ngữ',
    text: 'Chuẩn đầu ra ngoại ngữ tiếng Anh tương đương IELTS 6.0 hoặc TOEIC 650. Sinh viên nộp chứng chỉ ngoại ngữ còn hạn để xét tốt nghiệp. Chứng chỉ ngoại ngữ khác như tiếng Nhật, tiếng Pháp được quy đổi theo bảng tương đương.',
    questions: [
      'Chuẩn đầu ra tiếng Anh là IELTS bao nhiêu?',
      'TOEIC bao nhiêu điểm thì đạt chuẩn ngoại ngữ?',
      'Chứng chỉ tiếng Nhật có được quy đổi chuẩn đầu ra không?',
      'Nộp chứng chỉ ngoại ngữ để xét tốt nghiệp thế nào?',
      'Chứng chỉ ngoại ngữ hết hạn có được dùng không?',
    ],
  },
  {
    title: 'Quy định xét tốt nghiệp',
    text: 'Điều kiện xét tốt nghiệp: tích lũy đủ số tín chỉ của chương trình, điểm trung bình tích lũy từ 2.0 trở lên, đạt chuẩn đầu ra, không bị truy cứu trách nhiệm hình sự. Xếp loại tốt nghiệp xuất sắc khi điểm trung bình từ 3.6. Hội đồng xét tốt nghiệp họp mỗi quý.',
    questions: [
      'Điều kiện xét tốt nghiệp gồm những gì?',
      'Điểm trung bình tích lũy tối thiểu để tốt nghiệp?',
      'Xếp loại tốt nghiệp xuất sắc cần điểm bao nhiêu?',
      'Hội đồng xét tốt nghiệp họp khi nào?',
      'Bị truy cứu trách nhiệm hình sự có được xét tốt nghiệp?',
    ],
  },
  {
    title: 'Quy định học bổng khuyến khích học tập',
    text: 'Học bổng khuyến khích học tập xét theo điểm trung bình học kỳ và điểm rèn luyện. Mức học bổng loại giỏi bằng học phí học kỳ cộng mười phần trăm. Sinh viên có học phần dưới điểm C không được xét học bổng.',
    questions: [
      'Học bổng khuyến khích học tập xét theo tiêu chí nào?',
      'Mức học bổng loại giỏi là bao nhiêu?',
      'Có học phần điểm C có được xét học bổng không?',
      'Điểm rèn luyện có ảnh hưởng học bổng không?',
      'Học bổng khuyến khích được xét mỗi học kỳ phải không?',
    ],
  },
  {
    title: 'Quy định nghiên cứu khoa học của giảng viên',
    text: 'Giảng viên phải hoàn thành định mức nghiên cứu khoa học hằng năm quy đổi theo giờ chuẩn. Bài báo khoa học đăng tạp chí ISI hoặc Scopus được quy đổi nhiều giờ chuẩn nhất. Đề tài nghiên cứu cấp trường đăng ký vào tháng chín.',
    questions: [
      'Định mức nghiên cứu khoa học của giảng viên tính thế nào?',
      'Bài báo Scopus quy đổi giờ chuẩn ra sao?',
      'Khi nào đăng ký đề tài nghiên cứu cấp trường?',
      'Bài báo ISI có được quy đổi giờ chuẩn không?',
      'Giảng viên không đủ định mức nghiên cứu thì sao?',
    ],
  },
  {
    title: 'Quy định công tác phí',
    text: 'Công tác phí trong nước gồm tiền tàu xe, phụ cấp lưu trú và tiền thuê phòng nghỉ. Thanh toán công tác phí trong vòng mười ngày sau chuyến công tác, kèm giấy đi đường và hóa đơn hợp lệ. Mức phụ cấp lưu trú hai trăm nghìn đồng mỗi ngày.',
    questions: [
      'Công tác phí trong nước gồm những khoản nào?',
      'Thanh toán công tác phí trong bao lâu?',
      'Mức phụ cấp lưu trú mỗi ngày là bao nhiêu?',
      'Cần giấy tờ gì để thanh toán công tác phí?',
      'Tiền thuê phòng nghỉ đi công tác có được thanh toán không?',
    ],
  },
  {
    title: 'Quy định thực tập tốt nghiệp',
    text: 'Thực tập tốt nghiệp kéo dài mười tuần tại doanh nghiệp. Sinh viên nộp báo cáo thực tập và nhận xét của đơn vị thực tập. Giảng viên hướng dẫn thực tập chấm điểm báo cáo. Sinh viên tự liên hệ hoặc được khoa giới thiệu nơi thực tập.',
    questions: [
      'Thực tập tốt nghiệp kéo dài bao lâu?',
      'Nộp những gì sau khi thực tập tốt nghiệp?',
      'Ai chấm điểm báo cáo thực tập?',
      'Sinh viên tìm nơi thực tập thế nào?',
      'Nhận xét của đơn vị thực tập có bắt buộc không?',
    ],
  },
  {
    title: 'Quy định ký túc xá',
    text: 'Sinh viên đăng ký ở ký túc xá đầu năm học trực tuyến. Giá phòng ký túc xá tính theo tháng. Ưu tiên sinh viên năm nhất ở tỉnh xa và sinh viên diện chính sách. Vi phạm nội quy ký túc xá ba lần bị chấm dứt hợp đồng.',
    questions: [
      'Đăng ký ở ký túc xá khi nào?',
      'Giá phòng ký túc xá tính thế nào?',
      'Ai được ưu tiên ở ký túc xá?',
      'Vi phạm nội quy ký túc xá bị xử lý ra sao?',
      'Sinh viên năm nhất tỉnh xa có được ưu tiên ký túc xá?',
    ],
  },
];

async function load(kbId: string, doc: (typeof CORPUS)[number]) {
  const created = await store.createDocument({
    kbId,
    title: doc.title,
    fileName: 'qd.txt',
    mime: 'text/plain',
    size: doc.text.length,
    effectiveDate: '2026-09-01',
    replacesId: null,
    uploadedBy: 'ai',
  });
  const chunks = chunkText(doc.text);
  const vectors = await embedder.embed(
    chunks.map((c) => `${doc.title}\n${c.text}`),
    'document',
  );
  await store.completeDocument(
    created,
    chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })),
    1,
  );
  return created.id;
}

async function chat(who: string, body: Record<string, unknown>) {
  const res = await http()
    .post('/api/ai/chat')
    .set('Authorization', tokenFor(who))
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  const events: ChatStreamEvent[] = [];
  if (res.status === 200) {
    const p = createSseParser((e) => events.push(e));
    p.push(res.body as string);
    p.end();
  }
  return { status: res.status, events };
}

beforeAll(async () => {
  ({ app, requests } = (await startApp()) as never);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  requests.length = 0;
  await givenUser(app, 'gv-kt', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'gv-qt', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ai', 'ai_admin');
});

describe('RAG retrieval', () => {
  it('cites the right regulation for ≥ 90 % of 50 questions', async () => {
    const kb = await store.createKb({ name: 'Quy chế', description: '', aclScopeId: null }, 'ai');
    const ids = new Map<string, string>();
    for (const doc of CORPUS) ids.set(doc.title, await load(kb.id, doc));
    const retrieval = app.get(KnowledgeRetrieval);
    const profile = { uid: 'gv-qt', role: 'user' } as never;
    let correct = 0;
    const misses: string[] = [];
    for (const doc of CORPUS) {
      for (const q of doc.questions) {
        const { citations } = await retrieval.retrieve(profile, [kb.id], q, 24_000);
        if (citations[0]?.documentId === ids.get(doc.title)) correct += 1;
        else misses.push(q);
      }
    }
    expect(CORPUS.flatMap((d) => d.questions)).toHaveLength(50);
    expect(correct / 50, misses.join('\n')).toBeGreaterThanOrEqual(0.9);
  });
});

describe('RAG in chat', () => {
  it('sends passages before the question, streams and stores citations', async () => {
    const kb = await store.createKb({ name: 'Quy chế', description: '', aclScopeId: null }, 'ai');
    const docId = await load(kb.id, CORPUS[1]!);
    const res = await chat('gv-qt', {
      message: 'Hạn đóng học phí là khi nào?',
      knowledgeBaseIds: [kb.id],
    });
    expect(res.status).toBe(200);
    const cites = res.events.find((e) => e.type === 'citations');
    expect(cites).toMatchObject({
      citations: [{ n: 1, documentId: docId, title: 'Quy định học phí', version: 1 }],
    });
    const sent = requests[0]!.messages.at(-1)!.content;
    expect(sent).toContain('[1] Quy định học phí (phiên bản 1, hiệu lực 01/09/2026)');
    expect(sent.endsWith('Câu hỏi:\nHạn đóng học phí là khi nào?')).toBe(true);

    const meta = res.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const detail = await http()
      .get(`/api/conversations/${meta.conversationId}`)
      .set('Authorization', tokenFor('gv-qt'))
      .expect(200);
    expect(detail.body.conversation.knowledgeBaseIds).toEqual([kb.id]);
    expect(detail.body.messages[0].content).toBe('Hạn đóng học phí là khi nào?');
    expect(detail.body.messages[1].citations[0].documentId).toBe(docId);
  });

  it('never searches bases outside the user’s unit (ACL before search)', async () => {
    const unitKb = await store.createKb(
      { name: 'Nội bộ Khoa KTQT', description: '', aclScopeId: 'KTQT' },
      'ai',
    );
    await load(unitKb.id, CORPUS[7]!);
    const publicKb = await store.createKb(
      { name: 'Chung', description: '', aclScopeId: null },
      'ai',
    );

    const listed = async (who: string) =>
      (
        await http().get('/api/knowledge-bases').set('Authorization', tokenFor(who)).expect(200)
      ).body.knowledgeBases
        .map((k: { id: string }) => k.id)
        .sort();
    expect(await listed('gv-kt')).toEqual([unitKb.id, publicKb.id].sort());
    expect(await listed('gv-qt')).toEqual([publicKb.id]);
    expect(await listed('ai')).toHaveLength(2);

    const leak = await chat('gv-qt', {
      message: 'Mức phụ cấp lưu trú công tác phí?',
      knowledgeBaseIds: [unitKb.id],
    });
    expect(leak.status).toBe(403);
    expect(requests).toHaveLength(0);
    // A unit member gets it.
    const ok = await chat('gv-kt', {
      message: 'Mức phụ cấp lưu trú công tác phí?',
      knowledgeBaseIds: [unitKb.id],
    });
    expect(ok.events.some((e) => e.type === 'citations')).toBe(true);
    // Switching a base off hides it from everyone.
    await store.updateKb(unitKb.id, { active: false });
    expect((await chat('gv-kt', { message: 'x', knowledgeBaseIds: [unitKb.id] })).status).toBe(403);
  });

  it('says so when the selected bases have nothing related', async () => {
    const kb = await store.createKb({ name: 'Quy chế', description: '', aclScopeId: null }, 'ai');
    await load(kb.id, CORPUS[9]!);
    const res = await chat('gv-qt', { message: 'Thủ đô của Úc?', knowledgeBaseIds: [kb.id] });
    expect(res.events.some((e) => e.type === 'citations')).toBe(false);
    expect(requests[0]!.messages.at(-1)!.content).toContain('Không tìm thấy đoạn liên quan');
  });
});
