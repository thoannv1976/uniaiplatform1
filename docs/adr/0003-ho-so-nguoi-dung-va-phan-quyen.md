# ADR 0003 – Hồ sơ người dùng, danh bạ và phân quyền

- Trạng thái: Đã chấp nhận (M2, 01/10/2026)

## Bối cảnh

Firebase Auth chỉ cho biết _ai_ đăng nhập (uid, email). Vai trò, đơn vị và trạng thái phải do nhà trường
quản lý. Danh sách cán bộ (M3) được nhập theo email, khi đó chưa biết uid.

## Quyết định

1. **`userDirectory/{email}`** (email viết thường) là danh bạ do nhà trường cấp: vai trò, đơn vị, trạng thái.
   Super Admin đầu tiên được tạo bằng script ops; M3 nhập CSV vào đây.
2. **`users/{uid}`** là hồ sơ tạo khi đăng nhập lần đầu (`GET /api/me`):
   - có trong danh bạ → sao chép vai trò/đơn vị, trạng thái theo danh bạ (thường là `active`);
   - không có → `role = user`, `status = pending` (chờ duyệt).
     Thay đổi trong danh bạ sau đó (nhập lại CSV, script ops) được đồng bộ sang hồ sơ đã có.
3. Mỗi yêu cầu API đọc hồ sơ từ Firestore (không dùng custom claims làm nguồn sự thật), nên khóa tài khoản
   có hiệu lực ở yêu cầu kế tiếp. Khi khóa, API đồng thời thu hồi refresh token.
4. Chỉ `GET /api/me` cho phép tài khoản `pending`/`locked` (để giao diện hiển thị trạng thái); mọi endpoint
   khác yêu cầu `active` và vai trò khai báo bằng `@Roles(...)`.
5. Unit Admin chỉ thấy người dùng có `departmentId` thuộc `scopeDepartmentId` của mình.
6. Audit ghi vào `auditLogs` (Firestore, chỉ thêm) và log JSON có trường `audit: true` ra stdout để
   Cloud Logging thu thập; M10 định tuyến log này vào bucket có khóa retention.

## Hệ quả

- Không cần biết uid khi nhập danh sách cán bộ.
- Thêm 1 lượt đọc Firestore cho mỗi yêu cầu API (chấp nhận được ở quy mô 1.000 người dùng).
