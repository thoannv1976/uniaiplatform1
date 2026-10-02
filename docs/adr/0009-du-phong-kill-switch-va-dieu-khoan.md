# ADR 0009 – Dự phòng (fallback), circuit breaker, kill switch, audit và điều khoản sử dụng

- Trạng thái: Đã chấp nhận (M10, 02/10/2026)

## Bối cảnh

Đặc tả 8.8, 8.12, 12: nhà cung cấp AI lỗi không làm sập hệ thống; tắt AI trong < 5 giây; ghi audit mọi yêu cầu AI;
người dùng đồng ý điều khoản ở lần đăng nhập đầu tiên. Không dùng Redis (đặc tả mục 3): trạng thái dùng chung nằm
trong Firestore, trạng thái ngắn hạn trong bộ nhớ từng instance.

## Quyết định

1. **Fallback** (`ChatService.stream`): lỗi có thể thử lại (429, 5xx, timeout) hoặc model từ chối (`refusal`), **chỉ
   khi chưa stream chữ nào**, tối đa **1 lần** → `ModelRouter.fallback`: model cùng nhóm, nhà cung cấp khác, đang dùng
   được, hợp vai trò, đọc được ảnh nếu tin nhắn có ảnh. Lần gọi lỗi được quyết toán riêng (có token thì ghi sổ cái,
   không thì hoàn trả); lần dự phòng có bản ghi sổ cái mới với `fallbackFrom`. Trình duyệt nhận sự kiện `meta` thứ
   hai với model thật; tin nhắn lưu `modelId` của model đã trả lời.
2. **Circuit breaker** trong bộ nhớ mỗi instance: 3 lỗi có thể thử lại liên tiếp → ngắt nhà cung cấp 30 giây, sau đó
   cho một yêu cầu thử; thành công thì đóng. AUTO bỏ qua nhà cung cấp đang ngắt; chọn tay → 503 kèm số giây chờ.
3. **Kill switch** `settings/killSwitch` (`all`, `providers`, `models`, `tiers`, `reason`): mỗi instance API giữ
   listener `onSnapshot`; listener lỗi → đọc lại mỗi 5 giây. Đổi qua trang **Kill switch** (Super Admin, AI Admin),
   audit `ADMIN_CHANGE`. **Phanh khẩn cấp**: job tổng hợp 5 phút tự tắt nhóm Nâng cao + Cao cấp khi chi phí toàn
   trường đạt `autoBrakePercent` % ngân sách (mặc định 100, để trống = tắt), báo Super Admin.
4. **Giới hạn tốc độ theo model** (`rateLimitPerMinute` trong Model Registry) tính trong cùng transaction định mức
   (`quotaPeriods.modelRate`), bên cạnh giới hạn theo nhóm định mức (M7).
5. **Audit** bổ sung: `AI_REQUEST` (model, token, chi phí, độ trễ, trạng thái), `MODEL_ROUTED` (khi hệ thống chọn
   model), `FALLBACK_USED`, `API_ERROR`, `TERMS_ACCEPTED`. Chỉ ghi id, không ghi nội dung. Ghi không chặn yêu cầu.
   Dòng log `"audit": true` được sink sang log bucket `uniai-audit` (365 ngày; khóa retention cần Chủ dự án xác nhận).
6. **Điều khoản sử dụng** (`TERMS_VERSION` trong `packages/shared/src/terms.ts`): chưa đồng ý phiên bản hiện hành
   → giao diện hiện màn hình điều khoản; API từ chối `POST /api/ai/chat` và `POST /api/files` (403). Đổi nội dung =
   tăng phiên bản = mọi người đồng ý lại.

## Hệ quả

- Circuit breaker không chia sẻ giữa các instance (tối đa vài instance – chấp nhận được).
- Mỗi yêu cầu AI thêm 1–2 lần ghi `auditLogs` (rẻ; giúp tra cứu). Có thể chuyển `AI_REQUEST` sang chỉ Cloud Logging
  nếu khối lượng lớn.
