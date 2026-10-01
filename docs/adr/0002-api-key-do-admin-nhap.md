# ADR 0002 – API key nhà cung cấp do Admin nhập trên giao diện

- Trạng thái: Đã chấp nhận (quyết định D4, D5 – 01/10/2026)

## Bối cảnh

Chủ dự án muốn Admin tự nhập API key (OpenAI, và tùy chọn Google AI / Anthropic) trong trang quản trị,
thay vì nhờ người vận hành nạp bằng dòng lệnh. Gemini và Claude mặc định vẫn gọi qua Vertex AI (không cần key).

## Quyết định

1. Key **không bao giờ lưu trong Firestore** và không bao giờ trả lại cho trình duyệt.
2. Key được ghi thành **phiên bản mới của secret trong Secret Manager**. Các secret được tạo sẵn
   (rỗng) bởi `infra/bootstrap.sh`: `openai-api-key`, `gemini-api-key`, `anthropic-api-key`.
3. Service account `uniai-api` chỉ có quyền `secretVersionAdder` và `secretAccessor` **trên đúng 3 secret này**
   (không có quyền tạo/xóa secret, không có quyền ở cấp project).
4. Firestore (`providers/{id}`) chỉ lưu metadata: đã có key hay chưa, 4 ký tự cuối, người cập nhật, thời điểm.
5. Chỉ vai trò Super Admin được nhập/xoay key; mỗi lần đổi key ghi audit `ADMIN_CHANGE` (không ghi giá trị key).
6. API đọc key từ Secret Manager khi khởi động và làm mới khi metadata trong Firestore thay đổi (listener).
7. Transport theo nhà cung cấp: OpenAI = `direct`; Gemini, Claude = `vertex` mặc định, đổi sang `direct`
   được nếu Admin đã nhập key.

## Hệ quả

- Không cần Cowork nạp key bằng dòng lệnh; Cowork chỉ cần chạy bootstrap (tạo secret rỗng + IAM).
- Giao diện nhập key là trường chỉ-ghi (write-only); hiển thị dạng `sk-…abcd`.
- Phần giao diện và API quản lý key thuộc milestone M4.
