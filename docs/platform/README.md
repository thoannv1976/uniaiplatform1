# Platform API – hướng dẫn tích hợp cho ứng dụng nội bộ

Platform API cho phép ứng dụng nội bộ của Trường (LMS, cổng sinh viên, AI Tutor…) dùng chung AI Gateway, với cùng
quy định như chatbot: DLP, định tuyến AUTO, kill switch, ngân sách và nhật ký chi phí. Thiết kế: ADR 0016. Đặc tả
máy đọc được: [`openapi.json`](openapi.json) (OpenAPI 3.1; Super Admin/AI Admin/Auditor cũng tải được tại
`GET /api/admin/platform/openapi.json`).

## 1. Xin cấp ứng dụng

Đơn vị chủ quản gửi yêu cầu cho Super Admin hoặc AI Admin gồm: tên ứng dụng, đơn vị chủ quản, người phụ trách kỹ
thuật, ngân sách tháng (USD), số yêu cầu/phút, quyền cần (`chat`, `models`, `usage`) và có cần model nhóm Nâng
cao/Cao cấp hay không. Quản trị viên tạo ở **Trang quản trị → Ứng dụng**; **API key chỉ hiện một lần**.

- Key có dạng `uak_<mã ứng dụng>_<bí mật>`. Lưu trong kho bí mật của ứng dụng (Secret Manager, biến môi trường
  của máy chủ…), **không** đưa vào mã nguồn, ứng dụng chạy trên trình duyệt hay ứng dụng di động, không gửi qua
  chat/email/Issue. Lộ key: báo quản trị viên **Đổi key** – key cũ ngừng hoạt động ngay.
- Ngân sách tháng của ứng dụng được tính vào phần "đã cấp" của đơn vị chủ quản: không cấp vượt ngân sách đơn vị.
  Chi phí thực tế hiện trong Thống kê và Báo cáo tháng của đơn vị.

## 2. Gọi API

Địa chỉ: địa chỉ API của môi trường (staging: `https://uniai-api-staging-….run.app`; production: địa chỉ do quản
trị viên cung cấp hoặc tên miền riêng). Mọi yêu cầu có header `Authorization: Bearer uak_…`.

```bash
curl -sS "$UNIAI_API_URL/api/platform/v1/chat" \
  -H "Authorization: Bearer $UNIAI_APP_KEY" -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"role": "system", "content": "Bạn là trợ lý học tập của LMS."},
      {"role": "user", "content": "Tóm tắt chương 1 trong 3 ý"}
    ],
    "model": "auto",
    "reference": "lms:course-42"
  }'
```

Trả về:

```json
{
  "id": "…mã giao dịch sổ cái…",
  "model": { "id": "…", "displayName": "…", "providerId": "openai", "tier": "economy" },
  "routeReason": "AUTO: …",
  "output": "…câu trả lời…",
  "stopReason": "end",
  "usage": { "inputTokens": 120, "outputTokens": 80, "cachedInputTokens": 0 },
  "cost": 1250,
  "latencyMs": 2400
}
```

- **Không lưu hội thoại**: muốn hỏi tiếp, gửi lại các tin nhắn trước (`assistant`/`user`), tin cuối phải là `user`.
  Tối đa 50 tin nhắn, tổng 200.000 ký tự.
- `model`: `"auto"` (khuyến nghị) hoặc mã model trong `GET /api/platform/v1/models`.
- `stream: true`: trả Server-Sent Events `meta` → nhiều `delta` (`text`) → `done` (chi phí); có dòng `: ping` mỗi 15
  giây để giữ kết nối. Thời gian tối đa một yêu cầu: 15 phút.
- `maxOutputTokens` (tùy chọn): giới hạn độ dài câu trả lời (và chi phí giữ trước).
- `reference` (tùy chọn): mã tham chiếu của ứng dụng (≤ 64 ký tự `A-Z a-z 0-9 . _ : -`), lưu vào sổ cái để đối
  soát. Không đưa dữ liệu cá nhân vào đây.
- Tiền tính bằng **micro-USD** (số nguyên; 1 USD = 1.000.000).

`GET /api/platform/v1/usage` (quyền `usage`): ngân sách, đã dùng, còn lại trong tháng.

Ví dụ hoàn chỉnh (Node.js 20+, không cần thư viện): [`examples/platform-client/chat.mjs`](../../examples/platform-client/chat.mjs).

## 3. Mã lỗi

| HTTP    | Ý nghĩa                                                     | Ứng dụng nên                                            |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 400     | Yêu cầu sai định dạng                                       | Sửa yêu cầu (xem `message`)                             |
| 401     | Thiếu/sai key, hoặc key đã được đổi                         | Kiểm tra key                                            |
| 402     | Hết ngân sách tháng của ứng dụng                            | Báo quản trị viên tăng ngân sách                        |
| 403     | Ứng dụng bị tạm dừng, thiếu quyền, hoặc model ngoài phạm vi | Liên hệ quản trị viên                                   |
| 422     | DLP chặn (mật khẩu, khóa bí mật, tài liệu mật…)             | Không gửi dữ liệu đó                                    |
| 428     | DLP cảnh báo (ví dụ dữ liệu sinh viên)                      | Chỉ gửi lại với `"dlpAcknowledged": true` nếu được phép |
| 429     | Quá số yêu cầu/phút                                         | Chờ theo header `Retry-After`                           |
| 502/503 | Nhà cung cấp AI lỗi hoặc AI đang tạm dừng (kill switch)     | Thử lại sau, có giới hạn số lần                         |

Giá trị DLP che (ví dụ số CCCD) được thay bằng nhãn `[CCCD_1]` trước khi gửi nhà cung cấp và được khôi phục trong
câu trả lời trả về ứng dụng.

## 4. Trách nhiệm của ứng dụng

- Người dùng cuối của ứng dụng phải được thông báo nội dung được xử lý bởi AI và tuân thủ điều khoản sử dụng AI của
  Trường; ứng dụng tự xác thực và phân quyền người dùng của mình.
- Không gửi dữ liệu vượt quá chính sách dữ liệu của Trường; DLP là lớp bảo vệ cuối, không thay thế thiết kế đúng.
- Ghi lại `id` (mã giao dịch) để đối soát chi phí khi cần.
