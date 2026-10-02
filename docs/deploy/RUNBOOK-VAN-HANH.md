# Runbook vận hành – University AI Platform

Dành cho Super Admin, Claude Cowork và người trực vận hành. Project `uniaiplatform1`, vùng `asia-southeast1`.
Không dán API key, mật khẩu hay nội dung hội thoại vào Issue/chat.

## 1. Kiểm tra nhanh

```bash
curl -s https://<uniai-api URL>/health        # {"status":"ok",…}
gcloud run services list --region=asia-southeast1
gcloud scheduler jobs list --location=asia-southeast1
```

Cloud Logging: lọc `resource.labels.service_name="uniai-api" severity>=WARNING`. Cảnh báo chi phí:
`jsonPayload.alert=true`; audit: `jsonPayload.audit=true`; lỗi nhà cung cấp: `jsonPayload.event="provider_error"`.

## 2. Bật/tắt AI (kill switch) – hiệu lực < 5 giây

- Giao diện: **Trang quản trị → Kill switch** (Super Admin, AI Admin): chọn toàn bộ / nhà cung cấp / nhóm / model,
  ghi lý do (người dùng thấy) → **Lưu kill switch**. Bật lại: **Bật lại toàn bộ AI**.
- Khẩn cấp không vào được giao diện: Firestore console → database (`(default)` hoặc `staging`) → `settings/killSwitch`
  → đặt `all: true`, `reason: "…"` (tạo tài liệu nếu chưa có, các trường khác: `providers: []`, `models: []`,
  `tiers: []`, `autoBrakePercent: 100`, `auto: false`). Ghi lại thao tác vào Issue sự cố (audit không tự ghi khi sửa
  bằng console).
- Phanh khẩn cấp tự bật khi chi phí toàn trường ≥ `autoBrakePercent` % ngân sách: tăng ngân sách (tab Định mức) hoặc
  chấp nhận, rồi **Bật lại** trên trang Kill switch.

## 3. Rollback

**API/worker (Cloud Run)** – nhanh nhất, không cần build:

```bash
gcloud run revisions list --service=uniai-api --region=asia-southeast1 --limit=5
gcloud run services update-traffic uniai-api --region=asia-southeast1 --to-revisions=<REVISION_TRUOC>=100
# tương tự uniai-worker nếu cần; staging: thêm hậu tố -staging
```

Sau khi sửa lỗi, deploy mới tự chuyển 100 % traffic sang revision mới.

**Web (Firebase Hosting)**: Console → Hosting → site `uniaiplatform1` → Release history → bản trước → **Rollback**.

**Toàn bộ theo phiên bản**: tạo tag mới trỏ vào commit tốt, ví dụ `git tag v1.0.1 <sha-tot> && git push origin v1.0.1`
→ workflow Deploy (production) chờ Chủ dự án **Approve**.

Lưu ý: rollback mã không hoàn tác dữ liệu; index/TTL Firestore chỉ thêm.

## 4. Xoay API key (OpenAI hoặc key trực tiếp của Google/Anthropic)

1. Tạo key mới ở trang nhà cung cấp (đặt hạn mức chi tiêu tại tài khoản nhà cung cấp).
2. Super Admin → **Nhà cung cấp AI** → **Nhập key** (ô chỉ ghi) → lưu: tạo phiên bản secret mới
   `<provider>-api-key[-staging]`; API dùng key mới ngay (không cần deploy).
3. **Thử model** trên trang Model & giá (hoặc `pnpm ops:smoke-providers --database …`).
4. Vô hiệu phiên bản cũ: `gcloud secrets versions disable <so-cu> --secret=openai-api-key`; thu hồi key cũ tại nhà
   cung cấp. Key lộ: làm ngay bước 2–4, bật kill switch cho nhà cung cấp đó trong lúc chờ.

## 5. Sao lưu và khôi phục Firestore

Đã bật (infra/hardening.sh): PITR 7 ngày, backup hằng ngày giữ 14 ngày, cho `(default)` và `staging`.

```bash
gcloud firestore backups list --location=asia-southeast1
# Khôi phục vào DATABASE MỚI (không ghi đè database đang chạy):
gcloud firestore databases restore --source-backup=projects/uniaiplatform1/locations/asia-southeast1/backups/<ID> \
  --destination-database=restore-$(date +%Y%m%d)
```

Kiểm tra dữ liệu trong database mới (console). Chuyển hệ thống sang database đã khôi phục là thay đổi lớn: Chủ dự án
quyết định; cách làm – sửa `FIRESTORE_DB` trong `.github/workflows/deploy.yml` qua PR, deploy, kiểm tra, rồi xử lý
database cũ. Khôi phục một phần (ví dụ cấu hình bị xóa nhầm): đọc từ database `restore-…` và nhập lại qua giao diện.
RPO ≤ 24 giờ (backup) hoặc vài phút (PITR, đọc `--snapshot-time` bằng export); RTO mục tiêu ≤ 4 giờ.

## 6. Sự cố nhà cung cấp AI

1. Cảnh báo "tỷ lệ lỗi API > 5%" hoặc người dùng báo lỗi → xem log `provider_error` (mã lỗi, model).
2. Hệ thống tự chuyển model dự phòng (cùng nhóm, nhà cung cấp khác) và tự ngắt nhà cung cấp lỗi 30 giây.
3. Lỗi kéo dài → Kill switch tắt nhà cung cấp đó (lý do: "Sự cố <hãng>") để AUTO dùng hãng khác ngay.
4. Hết hạn mức/thẻ tại nhà cung cấp (429 liên tục) → nạp thêm tại tài khoản nhà cung cấp.

## 7. Sự cố bảo mật (đặc tả 12)

Kill switch → thu hồi/xoay key (mục 4) → khóa tài khoản liên quan (Trang quản trị → Tài khoản → Khóa: phiên hiện tại
hết hiệu lực ngay) → điều tra qua audit log (Auditor xuất CSV) → thông báo theo quy định của Trường.

## 8. Khóa retention log audit (KHÔNG ĐẢO NGƯỢC)

Chỉ thực hiện khi Chủ dự án xác nhận bằng văn bản trong Issue:

```bash
gcloud logging buckets update uniai-audit --location=asia-southeast1 --locked
```

Sau khi khóa: không giảm được thời hạn, không xóa được bucket trước hạn.

## 9. Định kỳ

- Hằng tháng: xem tab Thống kê, báo cáo chi phí; rà soát cảnh báo.
- Hằng quý: rà soát tài khoản Admin (Trang quản trị → Tài khoản), xoay API key.
- Mỗi kỳ học: diễn tập rollback trên staging (mục 3) và bật/tắt kill switch (mục 2).
