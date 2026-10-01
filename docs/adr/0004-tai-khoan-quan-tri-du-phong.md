# ADR 0004 – Tài khoản quản trị dự phòng (email + mật khẩu)

- Trạng thái: Đã chấp nhận (yêu cầu của Chủ dự án, 01/10/2026)

## Bối cảnh

Người dùng thường đăng nhập bằng Google với email `@ftu.edu.vn` (D2, D3). Chủ dự án cần thêm một tài khoản
quản trị đăng nhập bằng **email + mật khẩu**, có thể là email ngoài tên miền trường (ví dụ Gmail), để vào được
hệ thống khi Google Workspace của trường gặp sự cố hoặc trong lúc triển khai. Đặc tả mục 8.1 đã dự kiến
"1–2 tài khoản quản trị dự phòng".

## Quyết định

1. Biến `EXTRA_ALLOWED_EMAILS` (GitHub Actions Variable → biến môi trường Cloud Run của API): danh sách
   **email chính xác** được phép ngoài tên miền trường. Không có ký tự đại diện. Giữ danh sách rất ngắn.
2. API vẫn bắt buộc `email_verified = true`. Tài khoản dự phòng được tạo bằng `pnpm ops:create-login`
   (Admin SDK), script này đánh dấu email đã xác minh, vì người chạy (Owner của project) chịu trách nhiệm.
3. Mật khẩu chỉ được **gõ ẩn trong Cloud Shell**, không truyền trên dòng lệnh, không ghi log, không lưu ở
   repo, Issue, chat. Script yêu cầu ≥ 12 ký tự, ≥ 3 loại ký tự, không chứa tên email, không bắt đầu bằng
   chuỗi dễ đoán. Đặt lại mật khẩu thì thu hồi mọi phiên đang mở.
4. Vai trò cấp bằng `pnpm ops:grant-role --allow-outside-domain` (cờ bắt buộc, có cảnh báo).
5. Trên web, form email/mật khẩu nằm trong mục thu gọn "Tài khoản quản trị dự phòng"; thông báo lỗi giống
   nhau cho "sai email" và "sai mật khẩu" (không dò được tài khoản).
6. Firebase Authentication: **tắt tự đăng ký** (User actions → bỏ "Enable create (sign-up)") để không ai tự
   tạo tài khoản email/mật khẩu từ trình duyệt.

## Hệ quả

- Tài khoản dự phòng là điểm tấn công dò mật khẩu: Firebase tự giới hạn số lần thử; nên bật MFA khi nâng
  Identity Platform (giai đoạn sau). Rà soát danh sách `EXTRA_ALLOWED_EMAILS` hằng quý.
- Nhập CSV danh bạ vẫn chỉ nhận `@ftu.edu.vn`; tài khoản dự phòng chỉ tạo qua script ops.
