# Runbook M5 – AI Gateway, chat stream và production lần đầu

Người thực hiện: **Claude Cowork** (trình duyệt + Cloud Shell). Phần B cần **Chủ dự án** phê duyệt.
Thiết kế: ADR 0005. Không có bước nào KHÔNG ĐẢO NGƯỢC được.

## ⚠ Bí mật và dữ liệu

- Không dán API key, mật khẩu, ID token vào chat, Issue, PR, ảnh chụp.
- Không chụp nội dung hội thoại thật của người khác. Khi thử, dùng câu hỏi thử nghiệm.

## Phần A – Kiểm tra trên staging

Điều kiện: PR M5 đã merge, workflow **Deploy** (staging) xanh; Issue "Deploy M4" đã ĐẠT (hoặc ít nhất đã
**Nạp danh mục mẫu** để có model Mock).

### A1. Index và TTL của Firestore (Console)

Console → Firestore → chọn database **staging**:

- **Indexes → Composite**: `conversations` (ownerUid ↑, updatedAt ↓) và `usageTransactions` (uid ↑,
  requestTime ↓) ở trạng thái **Enabled**. Có thể mất vài phút sau deploy.
- **Time-to-live (TTL)**: chính sách trên trường `expireAt` cho `conversations` và `messages` ở trạng thái
  **Serving**. Có thể mất tới vài giờ.

Nếu thiếu: xem log bước "Deploy Firebase" của workflow Deploy, báo lại nguyên văn lỗi.

### A2. Chat qua Gateway (trang **Thử chat**, Super Admin hoặc AI Admin)

Mở `https://uniaiplatform1-staging.web.app` → **Trang quản trị** → tab **Thử chat**.

1. Model **AUTO**, gửi `Xin chào`. Kết quả: câu trả lời hiện dần, dòng cuối có token, chi phí (micro-USD),
   thời gian. (AUTO chọn model Tiết kiệm đang bật có ưu tiên cao nhất; nếu chỉ có Mock thì là Mock Economy.)
2. **Stream dài hơn 60 giây**: chọn **Mock Economy**, gửi `[mock:slow=75] thử stream dài`. Câu trả lời đếm
   `1… 2… … 75…` rồi kết thúc với trạng thái **xong**, không bị ngắt ở giây 60.
3. **Hủy giữa chừng**: gửi `[mock:slow=60] thử dừng`, sau khoảng 10 giây bấm **Dừng**. Trạng thái **đã dừng**.
4. **Lỗi nhà cung cấp**: gửi `[mock:fail=429] thử lỗi`. Thấy thông báo tiếng Việt "Nhà cung cấp AI đang quá tải…".
5. Nếu M4 đã bật model thật: chọn từng model (OpenAI, Gemini, Claude) gửi một câu ngắn, ghi lại chi phí.

### A3. Sổ cái và hội thoại (Console → Firestore → database staging)

- `usageTransactions`: có bản ghi cho các lần ở A2, `status = committed`; lần **Dừng** có
  `outcome = cancelled` và `totalCost > 0`; lần lỗi 429 **không** có bản ghi (không phát sinh token).
- `conversations`: có các hội thoại vừa tạo, mỗi tài liệu có `ownerUid`, `expireAt` ≈ 180 ngày sau.

### A4. CORS (Cloud Shell)

```bash
API=https://uniai-api-staging-lll6i7syia-as.a.run.app
curl -s -i -X OPTIONS "$API/api/ai/chat" -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: POST" | grep -i '^access-control-allow-origin' || echo "OK: tên miền lạ bị từ chối"
curl -s -i -X OPTIONS "$API/api/ai/chat" -H "Origin: https://uniaiplatform1-staging.web.app" \
  -H "Access-Control-Request-Method: POST" | grep -i '^access-control-allow-origin'
```

Lệnh đầu phải in "OK: tên miền lạ bị từ chối"; lệnh sau in đúng tên miền staging.

### A5. Quyết định D8

Hỏi Chủ dự án xác nhận thời hạn lưu nội dung hội thoại **180 ngày** (đang áp dụng). Nếu khác, ghi số ngày vào
Issue để Claude Code đổi biến `CONVERSATION_RETENTION_DAYS`.

## Phần B – Production lần đầu (chỉ nhóm nội bộ)

**Chỉ làm khi Phần A đạt và Chủ dự án đồng ý trong Issue.** Production dùng database `(default)`, site
`https://uniaiplatform1.web.app`, Cloud Run `uniai-api`, `uniai-worker`, secret `*-api-key` (không hậu tố).
Mock tự tắt ở production. Ai chưa có trong danh bạ `(default)` sẽ ở trạng thái **chờ duyệt** và không dùng được.

### B1. Phát hành (GitHub, Chủ dự án hoặc Cowork theo ủy quyền)

1. GitHub → **Releases → Draft a new release** → **Choose a tag**: gõ `v0.5.0` → **Create new tag on publish**,
   target `main` → tiêu đề `v0.5.0 – Production nội bộ (M1–M5)` → **Publish release**.
2. Actions → workflow **Deploy** của tag `v0.5.0` chờ duyệt ở môi trường `production` → Chủ dự án bấm
   **Review deployments → Approve**.
3. Chờ job xanh. Bước **Smoke test** in `GET /health -> 200` với `version` = `v0.5.0-<sha>` và
   `GET /api/me (không token) -> 401`.

### B2. Super Admin của production (Cloud Shell)

Firebase Auth dùng chung cho cả project, nhưng vai trò nằm trong từng database, nên phải cấp lại cho `(default)`:

```bash
cd ~/uniaiplatform1 && git checkout main && git pull && pnpm install && pnpm build
pnpm ops:grant-role --email <email-chu-du-an>@ftu.edu.vn --role super_admin --database "(default)"        # xem trước
pnpm ops:grant-role --email <email-chu-du-an>@ftu.edu.vn --role super_admin --database "(default)" --yes
```

Tài khoản quản trị dự phòng (nếu đã tạo ở staging): chạy thêm lệnh trên với email đó và
`--allow-outside-domain`. Biến `EXTRA_ALLOWED_EMAILS` dùng chung cho cả hai môi trường.

### B3. Cấu hình AI trên production (trình duyệt, Super Admin)

Trên `https://uniaiplatform1.web.app` → **Trang quản trị**:

1. **Model & giá** → **Nạp danh mục mẫu** (không có Mock ở production).
2. **Nhà cung cấp AI** → OpenAI → nhập API key **production** (key riêng, có hạn mức chi tiêu; không dùng lại
   key staging).
3. Với các model đã xác minh mã và giá ở staging (Issue "Deploy M4"): sửa mã/giá cho giống staging, bấm
   **Thử**, rồi **Bật**. Claude Opus 5.5 để tắt.
4. **Thử chat**: AUTO gửi `Xin chào` → nhận câu trả lời, thấy chi phí.

### B4. Người dùng nội bộ

Thêm nhóm nội bộ (vài người) vào danh bạ production: tab **Cán bộ → Nhập CSV** (database `(default)`), theo
`docs/deploy/M3-runbook.md`. Chưa mở cho toàn trường (pilot ở M10).

### Rollback production

- API/worker: Console → Cloud Run → `uniai-api` → **Revisions** → chuyển 100% traffic về revision trước,
  hoặc `gcloud run services update-traffic uniai-api --to-revisions=<REVISION>=100 --region asia-southeast1`.
- Web: Console → Hosting → site `uniaiplatform1` → **Release history** → **Rollback**.
- Tắt AI ngay: tab **Nhà cung cấp AI** → **Tắt** từng nhà cung cấp.

## Tiêu chí ĐẠT

- Staging: stream 75 giây không bị cắt; Dừng ghi `outcome = cancelled` có chi phí; lỗi 429 hiện tiếng Việt;
  CORS từ tên miền lạ bị từ chối; index Enabled, TTL Serving (hoặc đang tạo).
- Production (nếu được duyệt): Deploy `v0.5.0` xanh; Super Admin đăng nhập được; ít nhất một model thật trả
  lời qua **Thử chat** với chi phí đúng định dạng micro-USD.

## Báo cáo

Bình luận vào Issue "Deploy M5" theo mẫu mục 4.3 Kế hoạch build v1: kết quả A1–A5, B1–B4 (✓/✗), thời gian
stream dài thực tế, chi phí các lần thử, quyết định D8. **Không dán bí mật hay nội dung hội thoại thật.**
