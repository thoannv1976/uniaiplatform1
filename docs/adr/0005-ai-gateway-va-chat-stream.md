# ADR 0005 – AI Gateway và chat stream (SSE)

- Trạng thái: Đã chấp nhận (M5, 02/10/2026). Thời hạn lưu hội thoại theo đề xuất D8, chờ Chủ dự án chốt.

## Bối cảnh

Đặc tả 5.2 và 8.4 yêu cầu một API chat thống nhất cho mọi nhà cung cấp, trả lời dạng stream, hủy được giữa
chừng mà vẫn tính đúng chi phí. Firebase Hosting cắt rewrite sang Cloud Run sau 60 giây, nên không dùng được
cho câu trả lời dài.

## Quyết định

1. **`POST /api/ai/chat` trả Server-Sent Events**: `meta` (hội thoại, tin nhắn, model, lý do chọn), nhiều
   `delta`, có thể có `error`, và luôn kết thúc bằng `done` (trạng thái, token, chi phí micro-USD, độ trễ).
   Schema ở `packages/shared/src/chat.ts`. Web gọi **thẳng URL Cloud Run** bằng `fetch` (POST + header
   `Authorization`), không qua Hosting. Cloud Run: timeout 900 giây, concurrency 80, CORS chỉ tên miền web.
   API gửi `: ping` mỗi 15 giây để kết nối không bị coi là treo.
2. **Kiểm tra trước, stream sau**: lỗi dữ liệu, quyền, model không dùng được trả JSON 4xx/503 bình thường
   trước khi gửi byte nào. Sau khi stream bắt đầu, lỗi nhà cung cấp là sự kiện `error` + `done` (trạng thái
   `error`), thông báo tiếng Việt; chi tiết kỹ thuật chỉ ghi log (adapter đã lọc chuỗi giống key).
3. **Hủy = đóng kết nối.** API hủy lời gọi nhà cung cấp (AbortSignal), giữ phần đã sinh (trạng thái
   `cancelled`) và **vẫn quyết toán** chi phí phần đó.
4. **Sổ cái `usageTransactions`**: mỗi câu trả lời có token được ghi một bản `committed` (chi phí tách
   vào/cache/ra, giá áp dụng `priceId`, lý do chọn model, `departmentPath`). Không sửa, không xóa. Chi phí tính
   theo giá có hiệu lực **lúc nhận yêu cầu**. Giữ tạm định mức (reserve) thêm ở M7, trước bước gọi nhà cung cấp.
5. **Chọn model (tạm thời đến khi có Smart Router)**: AUTO = nhóm rẻ nhất có model dùng được (Tiết kiệm →
   Tiêu chuẩn → Nâng cao; không bao giờ chọn Cao cấp), rồi độ ưu tiên cao nhất. Model "dùng được" = đang bật,
   có giá hiện hành, nhà cung cấp sẵn sàng; Mock chỉ khi `ENABLE_MOCK_PROVIDER=true`. Model nhóm **Cao cấp**
   chỉ Super Admin và AI Admin chọn được cho tới khi nhóm định mức cấp quyền (M7). Registry được đọc qua bộ đệm
   30 giây (thay đổi giá/bật tắt có hiệu lực ≤ 60 giây như đặc tả 8.5).
6. **Hội thoại riêng tư**: `conversations/{id}` có `ownerUid`; chỉ chủ sở hữu đọc/sửa/xóa qua API, người khác
   (kể cả quản trị) nhận 404 như không tồn tại. Lịch sử gửi cho model: các tin nhắn gần nhất trong giới hạn
   ký tự theo cửa sổ ngữ cảnh, bỏ câu trả lời lỗi, gộp tin liên tiếp cùng vai trò, luôn bắt đầu bằng người dùng.
7. **Thời hạn lưu (D8)**: mặc định **180 ngày** (`CONVERSATION_RETENTION_DAYS`). Mỗi hội thoại và tin nhắn có
   `expireAt`; chính sách TTL của Firestore (khai trong `firestore.indexes.json`, deploy tự áp dụng) tự xóa.
   Sổ cái chi phí không có TTL.

## Hệ quả

- M6 dùng lại `streamChat` (web) và `createSseParser` (shared) cho giao diện chat.
- Trang **Thử chat** (Super/AI Admin) và chỉ thị Mock `[mock:slow=N]`, `[mock:fail=429|500|401]` dùng để
  kiểm tra staging; production tắt Mock.
- Khi Chủ dự án chốt D8 khác 180 ngày: đặt biến `CONVERSATION_RETENTION_DAYS` trong `deploy.yml`; hội thoại
  cũ giữ `expireAt` đã ghi cho tới lần cập nhật kế tiếp.
