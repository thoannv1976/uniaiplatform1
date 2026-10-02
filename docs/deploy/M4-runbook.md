# Runbook M4 – Model Registry và kết nối OpenAI, Gemini, Claude (staging)

Người thực hiện: **Claude Cowork** (Cloud Shell của project `uniaiplatform1` + trình duyệt).
Bước nhập API key: **Chủ dự án** (Super Admin) tự làm trên trang quản trị, hoặc đưa key trực tiếp cho
Cowork ngoài kênh chat với Claude Code.

## ⚠ Bí mật

- **Không** dán API key vào chat, Issue, PR, ảnh chụp hay lệnh có hiển thị (không `echo`, không tham số dòng lệnh).
- Key chỉ nhập vào ô **API key mới** (dạng mật khẩu) trên trang **Nhà cung cấp AI**. Hệ thống ghi vào
  Secret Manager và chỉ hiển thị lại 4 ký tự cuối (`…abcd`).
- Báo cáo chỉ ghi 4 ký tự cuối nếu cần, không ghi key.

## Điều kiện trước

- PR M4 đã merge vào `main`, workflow **Deploy** (staging) xanh.
- Có tài khoản **Super Admin** trên staging (Issue "Deploy M2" hoặc runbook tài khoản quản trị dự phòng).
- Chủ dự án đã tạo API key OpenAI **có hạn mức chi tiêu** (OpenAI → Settings → Limits).

## Bước 1 – Chạy lại bootstrap để tạo 3 secret của staging (Cloud Shell)

API key của staging và production nằm ở hai bộ secret khác nhau (ADR 0002, bổ sung ở M4).

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/bootstrap.sh --dry-run   # chỉ được thấy: tạo 3 secret *-api-key-staging + 6 quyền IAM
bash infra/bootstrap.sh
```

Kiểm tra: `gcloud secrets list --filter="name~api-key"` có đủ 6 secret.

## Bước 2 – Bật Claude trong Vertex AI Model Garden (console)

1. Console → **Vertex AI → Model Garden** → tìm lần lượt **Claude Haiku 4.5**, **Claude Sonnet 5.5**,
   **Claude Opus 5.5** → **Enable** (chấp nhận điều khoản của Anthropic).
2. Gemini không cần bật riêng.
3. **Vertex AI → Quotas**: kiểm tra quota của các model trên ở vị trí **global** (hệ thống gọi qua `global`).
4. **Billing → Budgets & alerts**: tạo ngân sách tháng cho project với cảnh báo 50/90/100% gửi Chủ dự án.

## Bước 3 – Nạp danh mục model (trình duyệt, Super Admin hoặc AI Admin)

1. Mở `https://uniaiplatform1-staging.web.app` → **Trang quản trị** → tab **Model & giá**.
2. Bấm **Nạp danh mục mẫu**: thêm 6 model thật (đều đang **tắt**) và 2 model Mock (đang bật, chỉ có ở staging).

## Bước 4 – Nhập API key OpenAI (Super Admin)

1. Tab **Nhà cung cấp AI** → thẻ **OpenAI** → dán key vào ô **API key mới cho OpenAI** → **Lưu key**.
2. Thẻ OpenAI chuyển sang **Sẵn sàng**, hiển thị `…` + 4 ký tự cuối.
3. Gemini và Claude để **Qua Vertex AI** (không cần key).

## Bước 5 – Thử từng model và xác minh mã model, giá

Tab **Model & giá** → với mỗi model thật bấm **Thử** → **Gửi thử**.

- **Gọi thành công**: ghi lại số token và chi phí (micro-USD).
- Lỗi `not_found` (HTTP 404): mã model chưa đúng. Tra mã chính xác (Vertex AI Model Garden cho Gemini/Claude,
  trang Models của OpenAI) → **Sửa** → **Mã model của nhà cung cấp** → **Lưu** → thử lại.
  Ghi chú: các mã GPT-6 Luna, GPT-6.1 Sol, Gemini 3.1 Flash-Lite lấy từ bản mô tả gốc, **cần xác minh**.
- Lỗi `auth` (401/403): Claude chưa được bật ở Bước 2, hoặc key OpenAI sai.
- Lỗi `rate_limited` (429): quota Vertex AI hoặc hạn mức OpenAI.

Giá: mở bảng giá chính thức (Vertex AI pricing cho Gemini/Claude, OpenAI pricing). Nếu khác giá trong
hệ thống → **Giá** → **Thêm giá** (USD cho 1 triệu token; giá cache nếu có). Không sửa được giá cũ: giá
mới có hiệu lực từ lúc nhập (hoặc thời điểm chọn trong tương lai).

## Bước 6 – Chạy smoke-providers (Cloud Shell)

Gọi mỗi model một câu ngắn bằng quyền của tài khoản Cowork và in bảng token/chi phí:

```bash
cd ~/uniaiplatform1 && pnpm install && pnpm build
pnpm ops:smoke-providers --database staging --include-disabled
```

Script chỉ đọc Firestore và Secret Manager, không ghi gì. Lệnh trả mã 1 nếu có model lỗi.

## Bước 7 – Bật model

Bật (**Bật**) các model đã thử thành công và đã xác minh giá. **Claude Opus 5.5** để tắt cho tới khi Chủ dự án
quyết định nhóm được dùng (chỉ dành cho nhóm nghiên cứu).

## Xác minh (tiêu chí ĐẠT)

- Staging gọi được **cả 3 hãng**: ít nhất một model OpenAI, một Gemini, một Claude báo **Gọi thành công**.
- Chi phí hiển thị dạng số nguyên micro-USD, khớp số token × giá trong Registry.
- Firestore (database `staging`) → `auditLogs` có `ADMIN_CHANGE` với `seed_models`, `set_provider_key`,
  `test_model`; collection `providers` chỉ có `last4`, **không** có key.
- `gcloud secrets versions list openai-api-key-staging` có 1 phiên bản; secret production (`openai-api-key`)
  **không** có phiên bản nào mới.

## Rollback

- Tắt model (**Tắt**) hoặc tắt cả nhà cung cấp (**Tắt …** trên thẻ nhà cung cấp) – có hiệu lực ngay.
- Key sai hoặc lộ: thu hồi key ở trang của hãng, nhập key mới (tạo phiên bản secret mới). Có thể vô hiệu
  phiên bản cũ: `gcloud secrets versions disable <số> --secret=openai-api-key-staging`.
- Bước 1, 2 không cần hoàn tác (secret rỗng và model đã bật không phát sinh chi phí khi không gọi).

## Production

Chưa làm ở M4. Theo Kế hoạch build v1, production lần đầu sau M5. Khi đó lặp lại Bước 3–7 trên
`https://uniaiplatform1.web.app` (secret `*-api-key` không hậu tố; Mock tự tắt ở production).

## Báo cáo

Bình luận vào Issue "Deploy M4" theo mẫu ở mục 4.3 của Kế hoạch build v1: bảng kết quả smoke-providers
(model, cách gọi, token, chi phí, độ trễ), các mã model/giá đã sửa, model đã bật. **Không dán key.**
