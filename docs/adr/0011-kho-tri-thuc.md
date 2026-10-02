# ADR 0011 – Kho tri thức: nạp tài liệu, chia đoạn, embedding

- Trạng thái: Đã chấp nhận (M12, 02/10/2026)

## Bối cảnh

Đặc tả 8.9 và 13.2 (M12): AI Admin tải tài liệu chính thức lên Cloud Storage → Cloud Task → worker trích văn bản →
chia đoạn (~800 token, chồng lấn 100) → embedding Vertex AI → collection `chunks` có trường vector; có phiên bản,
ngày hiệu lực, theo dõi trạng thái từng tài liệu.

## Quyết định

1. **Dữ liệu**: `knowledgeBases/{id}` (tên, mô tả, `aclScopeId` = đơn vị được dùng, null = toàn trường, bật/tắt);
   `documents/{id}` (tiêu đề, phiên bản, ngày hiệu lực, trạng thái `uploading → queued → processing → ready | failed`,
   `superseded`, số trang, số đoạn, lỗi); `chunks/{documentId}_{index}` (kbId, documentId, tiêu đề, phiên bản, trang,
   văn bản, `embedding` vector 768 chiều). Tệp gốc giữ ở `gs://uniaiplatform1-uploads/kb/{env}/{kbId}/{documentId}`
   (văn bản chính thức, cần để xử lý lại) – khác tệp chat (ADR 0008) chỉ giữ văn bản trích.
2. **Tải lên** qua signed URL như tệp chat (≤ 50 MB, ≤ 2.000 trang), `complete` → hàng đợi.
3. **Xử lý** (`ingestDocument`, package mới `@uniai/documents` – dùng chung trích nội dung với tệp chat):
   Cloud Tasks `uniai-kb-ingest[-staging]` → `POST /jobs/kb-ingest` của worker (OIDC `uniai-scheduler`), tối đa
   5 lần với backoff. Tệp không dùng được → `failed` (không thử lại); lỗi tạm thời → trả lại hàng đợi. Cục bộ/test:
   xử lý ngay trong API (không có Cloud Tasks). Chưa cấu hình hàng đợi → tài liệu `failed` kèm hướng dẫn, nút
   **Xử lý lại**.
4. **Chia đoạn**: 3.200 ký tự (~800 token), chồng lấn 400 ký tự, ngắt ở đoạn/câu; giữ số trang (PDF) hoặc trang
   chiếu (PowerPoint). Tiêu đề tài liệu được ghép vào văn bản khi tạo embedding.
5. **Embedding**: Vertex AI `text-multilingual-embedding-002`, 768 chiều, vùng `asia-southeast1`
   (`RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY`); test dùng `MockEmbedder` (túi từ băm, không gọi mạng). Chi phí
   embedding nhỏ, không ghi sổ cái người dùng (thao tác quản trị).
6. **Index vector** Firestore (kbId + embedding, flat, COSINE) khai trong `firestore.indexes.json`; tìm kiếm mỗi kho
   một truy vấn `findNearest` có lọc `kbId` rồi gộp (dùng ở M13).
7. **Phiên bản**: tải bản mới "là phiên bản mới của" một tài liệu sẵn sàng → khi bản mới sẵn sàng, bản cũ
   `superseded` và đoạn của bản cũ bị xóa (chỉ tìm thấy nội dung hiện hành). Mọi thao tác ghi audit
   `KNOWLEDGE_UPDATE`.

## Hệ quả

- Kho dùng chung bucket tệp chat (khác thư mục, khác vòng đời: thư mục `kb/` không có luật xóa tự động).
- Đổi model embedding = phải xử lý lại toàn bộ tài liệu (index 768 chiều).
