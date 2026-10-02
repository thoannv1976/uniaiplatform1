# ADR 0008 – Tệp đính kèm trong chat

- Trạng thái: Đã chấp nhận (M9, 02/10/2026)

## Bối cảnh

Đặc tả 8.3: đính kèm PDF, Word, Excel, PowerPoint, ảnh; giới hạn dung lượng và số trang cấu hình được. Đặc tả 9:
`files/{id}`, Cloud Storage tải lên qua signed URL do API cấp, rules chặn truy cập trực tiếp. Web không được
truy cập trực tiếp Firestore/Storage ngoài URL do API cấp.

## Quyết định

1. **Luồng**: `POST /api/files {name, mime, size}` → API kiểm tra loại (theo đuôi tệp) và dung lượng, tạo
   `files/{id}` (`pending`) và trả **signed URL v4 PUT** 15 phút, ràng buộc `Content-Type` và
   `x-goog-content-length-range: 0,<size>` → trình duyệt PUT thẳng lên Cloud Storage → `POST /api/files/:id/complete`:
   API đọc tệp, kiểm tra **byte đầu** khớp loại, trích văn bản, lưu, đánh dấu `ready`, ghi audit `DOCUMENT_UPLOAD`
   (không ghi tên tệp).
2. **Bucket riêng** `gs://uniaiplatform1-uploads` (asia-southeast1, uniform access, chặn public, không soft delete),
   tạo bằng `infra/storage.sh` thay vì bucket Firebase mặc định: tạo được bằng script idempotent, cố định vùng.
   Thư mục: `tmp/{staging|production}/{uid}/{id}` (tệp gốc khi tải lên, vòng đời xóa sau 1 ngày) và
   `files/{env}/{uid}/{id}[.txt]` (văn bản đã trích, hoặc ảnh; xóa sau 180 ngày = D8). Tài liệu gốc **không giữ lại**
   sau khi trích – ít dữ liệu nhạy cảm hơn.
3. **Trích nội dung** trong API (đồng bộ, tệp ≤ 20 MB): PDF bằng `unpdf` (pdf.js), DOCX/XLSX/PPTX đọc XML trong zip
   bằng `fflate` (giới hạn giải nén 200 MB chống zip bomb), văn bản UTF-8/UTF-16. PDF không có lớp chữ (bản scan)
   bị từ chối với hướng dẫn gửi ảnh. Văn bản giữ tối đa 1.000.000 ký tự (cờ `truncated`).
4. **Giới hạn** (biến môi trường): `FILE_MAX_MB` (mặc định 20, tối đa 30), `FILE_MAX_PAGES` (200); ảnh ≤ 5 MB (giới
   hạn chung của các nhà cung cấp); tối đa 5 tệp mỗi tin nhắn.
5. **Vào model**: văn bản đặt trong khối `<tệp tên="…">` trước câu hỏi, chia đều phần độ dài còn lại theo cửa sổ
   ngữ cảnh của model (cắt bớt có ghi chú). Ảnh gửi dạng ảnh cho model có năng lực `image`; AUTO chọn model đọc
   được ảnh, chọn tay model không đọc ảnh → 400. Tin nhắn chỉ lưu `attachments: [{id, name, kind}]`; các lượt sau
   nạp lại nội dung tệp để hỏi tiếp.
6. **Phát triển cục bộ**: emulator không ký được URL → `FILE_UPLOAD_MODE=proxy`: trình duyệt PUT tới
   `PUT /api/files/:id/content` (chỉ có khi proxy; Cloud Run trả 404).

## Hệ quả

- Tệp hết hạn (180 ngày) trước hội thoại → model nhận ghi chú "không còn được lưu trữ". Đổi
  `CONVERSATION_RETENTION_DAYS` thì sửa `infra/storage-lifecycle.json` cho khớp.
- API cần 1 GiB bộ nhớ (PDF 20 MB) và quyền `iam.serviceAccountTokenCreator` trên chính nó để ký URL.
- Chưa quét DLP/virus (`scanStatus: not_scanned`) – giai đoạn 2.
