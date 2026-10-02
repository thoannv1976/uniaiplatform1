# ADR 0016 – Platform API cho ứng dụng nội bộ

- Trạng thái: Đã chấp nhận (M17, 02/10/2026)

## Bối cảnh

Đặc tả 9 (`appClients/{id}`: name, ownerDepartmentId, hashedKey, scopes, monthlyBudget), 10
(`POST /api/platform/v1/chat`, "API client key", OpenAPI nội bộ) và 13.3 (M17): ứng dụng nội bộ dùng chung AI
Gateway, có API key riêng (lưu dạng băm), định mức theo ứng dụng; tiêu chí: ứng dụng mẫu gọi được và bị tính phí
đúng ngân sách. Tên miền riêng qua Load Balancer đã có từ M16 (`infra/domain.sh`).

## Quyết định

1. **Ứng dụng** `appClients/{id}`: tên, mô tả, đơn vị chủ quản (+ `ownerDepartmentPath`), quyền (`chat`, `models`,
   `usage`), ngân sách tháng (micro-USD), số yêu cầu/phút, `allowAdvanced`, trạng thái (`active`/`disabled`),
   `keyHash`, `keyLast4`. Super Admin và AI Admin quản lý, Auditor xem (`/api/admin/app-clients`), audit
   `ADMIN_CHANGE` không bao giờ chứa key hay hash.
2. **API key** `uak_<mã ứng dụng 20 ký tự>_<43 ký tự base64url>` = 256 bit ngẫu nhiên. Chỉ lưu **SHA-256** của key
   (đủ an toàn vì key ngẫu nhiên dài, không cần hàm băm chậm như mật khẩu); tra theo mã ứng dụng trong key, so sánh
   bằng `timingSafeEqual`. Key chỉ trả về một lần khi tạo hoặc **Đổi key** (key cũ hết hiệu lực ngay). Key sai ghi
   audit `AUTH_DENIED` (`reason: app_key`) không kèm key. Mẫu key bị DLP nhận là khóa bí mật nếu ai đó dán vào chat.
3. **Xác thực**: endpoint Platform API khai báo `@AppScopeRequired(scope)`; `AuthGuard` toàn cục chỉ nhận key ứng
   dụng ở đó (không nhận đăng nhập cán bộ), kiểm tra trạng thái và quyền. Các endpoint khác không nhận key ứng dụng.
4. **Định mức theo ứng dụng** trong `QuotaService` (vẫn là nơi duy nhất trừ định mức): giữ trước/quyết toán trên
   `appQuotaPeriods/{clientId}_{YYYYMM}`; ngân sách, giới hạn tốc độ và trạng thái đọc từ `appClients` **trong
   transaction** (đổi ngân sách/tạm dừng có hiệu lực ngay). Hết ngân sách → 402, quá nhanh → 429 + Retry-After.
   Sổ cái `usageTransactions` ghi `uid = app:<id>`, `appClientId`, `reference`, đường dẫn đơn vị chủ quản → chi phí
   vào Thống kê, ngân sách đơn vị và Báo cáo tháng của đơn vị; bảng tổng hợp có `byApp` và không đếm ứng dụng là
   người dùng hoạt động. Sweeper giải phóng cả reservation của ứng dụng.
5. **Ngân sách đơn vị**: ngân sách tháng của ứng dụng đang chạy được tính vào phần "đã cấp" của đơn vị chủ quản và
   mọi đơn vị cha (cùng với định mức cán bộ). Không tạo/tăng/bật lại ứng dụng nếu vượt ngân sách một đơn vị đã đặt
   ngân sách; đơn vị cũng không hạ ngân sách xuống dưới phần đã cấp.
6. **Chat** `POST /api/platform/v1/chat`: không lưu hội thoại (ứng dụng gửi lịch sử cần thiết), trả JSON hoặc SSE
   (`meta`/`delta`/`done`/`error`). Cùng đường đi với chat web: DLP (`checkFor`, vai trò `user` + đường dẫn đơn vị
   chủ quản; cảnh báo cần `dlpAcknowledged`), Smart Router, kill switch, circuit breaker, một lần dự phòng trước khi
   có chữ, giữ trước chi phí xấu nhất (thu nhỏ `maxOutputTokens` cho vừa ngân sách còn lại). Ứng dụng không có
   `allowAdvanced` chỉ dùng nhóm Tiết kiệm/Tiêu chuẩn (AUTO tự hạ nhóm; chọn tay model Nâng cao → 403). Audit
   `AI_REQUEST` với actor `app:<id>`. Phần gọi nhà cung cấp dùng chung `runAttempt` với chat web.
7. **OpenAPI** 3.1 sinh từ chính các schema Zod (`buildPlatformOpenApi`, `z.toJSONSchema`):
   `docs/platform/openapi.json` (test kiểm tra không lệch; tạo lại bằng `pnpm --filter @uniai/shared openapi`) và
   `GET /api/admin/platform/openapi.json` cho quản trị viên. Hướng dẫn tích hợp `docs/platform/README.md`, ứng dụng
   mẫu `examples/platform-client/chat.mjs` (được test emulator chạy thật).

## Hệ quả

- Ứng dụng không dùng được kho tri thức (RAG) và tệp đính kèm ở M17: phân quyền kho theo cán bộ, chưa có mô hình
  quyền cho ứng dụng. Mở rộng khi có yêu cầu cụ thể (M18).
- Cảnh báo 80 % ngân sách chưa áp dụng cho ứng dụng (chỉ cán bộ, đơn vị, toàn trường); `GET /usage` để ứng dụng tự
  theo dõi.
- Key ứng dụng chỉ dùng phía máy chủ; ứng dụng chạy trên trình duyệt/di động phải gọi qua máy chủ của chính nó
  (API không bật CORS cho Platform API).
