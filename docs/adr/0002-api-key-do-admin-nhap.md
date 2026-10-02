# ADR 0002 – API key nhà cung cấp do Admin nhập trên giao diện

- Trạng thái: Đã chấp nhận (quyết định D4, D5 – 01/10/2026)

## Bối cảnh

Chủ dự án muốn Admin tự nhập API key (OpenAI, và tùy chọn Google AI / Anthropic) trong trang quản trị,
thay vì nhờ người vận hành nạp bằng dòng lệnh. Gemini và Claude mặc định vẫn gọi qua Vertex AI (không cần key).

## Quyết định

1. Key **không bao giờ lưu trong Firestore** và không bao giờ trả lại cho trình duyệt.
2. Key được ghi thành **phiên bản mới của secret trong Secret Manager**. Các secret được tạo sẵn
   (rỗng) bởi `infra/bootstrap.sh`, **tách theo môi trường** (bổ sung ở M4) để key nhập trên staging
   không bao giờ dùng cho production:
   - production (database `(default)`): `openai-api-key`, `gemini-api-key`, `anthropic-api-key`;
   - staging (database `staging`): `openai-api-key-staging`, `gemini-api-key-staging`, `anthropic-api-key-staging`.
     API chọn secret theo `FIRESTORE_DATABASE_ID` (`secretNameFor` trong `packages/ai-providers`).
3. Service account `uniai-api` chỉ có quyền `secretVersionAdder` và `secretAccessor` **trên đúng 6 secret này**
   (không có quyền tạo/xóa secret, không có quyền ở cấp project).
4. Firestore (`providers/{id}`) chỉ lưu metadata: đã có key hay chưa, 4 ký tự cuối, người cập nhật, thời điểm.
5. Chỉ vai trò Super Admin được nhập/xoay key; mỗi lần đổi key ghi audit `ADMIN_CHANGE` (không ghi giá trị key).
6. API đọc key từ Secret Manager khi cần gọi nhà cung cấp và giữ adapter trong bộ nhớ. Mỗi lần Admin nhập key,
   `providers/{id}.key.updatedAt` đổi; lần gọi kế tiếp (ở mọi instance) thấy dấu thời gian mới và đọc phiên bản
   `latest`. Không dùng listener realtime cho key vì Cloud Run chỉ cấp CPU trong lúc xử lý request.
7. Transport theo nhà cung cấp: OpenAI = `direct`; Gemini, Claude = `vertex` mặc định, đổi sang `direct`
   được nếu Admin đã nhập key.

8. Nút **Thử** (`POST /api/admin/models/:id/test`, Super/AI Admin) gửi một câu ngắn để kiểm tra mã model,
   quyền truy cập và giá trước khi bật model. Lệnh thử tốn chi phí thật (rất nhỏ), được ghi audit
   `test_model`, không trừ định mức của ai. Lỗi từ nhà cung cấp được lọc chuỗi giống key trước khi trả về.

## Hệ quả

- Không cần Cowork nạp key bằng dòng lệnh; Cowork chỉ cần chạy bootstrap (tạo secret rỗng + IAM).
- Giao diện nhập key là trường chỉ-ghi (write-only); hiển thị dạng `sk-…abcd`.
- Phần giao diện và API quản lý key thuộc milestone M4 (đã làm: trang **Nhà cung cấp AI**, `PUT /api/admin/providers/:id/key`).
- Không có thao tác "xóa key" trên giao diện (SA không có quyền hủy phiên bản secret). Muốn ngừng dùng key:
  chuyển nhà cung cấp về Vertex AI hoặc tắt nhà cung cấp, rồi thu hồi key ở trang của hãng.
