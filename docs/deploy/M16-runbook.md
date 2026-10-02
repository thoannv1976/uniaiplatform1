# Runbook M16 – Báo cáo tháng, Excel, tên miền riêng

Người thực hiện: **Claude Cowork** (trình duyệt + Cloud Shell). Thiết kế: ADR 0015.
**Không có bước KHÔNG ĐẢO NGƯỢC.** Phần tên miền (bước 3–5) chỉ làm khi Chủ dự án đã chốt **D10** (tên miền) và Phòng
CNTT sẵn sàng tạo bản ghi DNS; nếu chưa, làm bước 1–2 và báo "chờ D10".

## Điều kiện trước

- PR M16 đã merge, workflow Deploy (staging) xanh.
- Cloud Shell với quyền Owner project `uniaiplatform1`; `git pull` bản mới nhất của repo.

## Bước 1 – Lịch chạy báo cáo tháng

```bash
bash infra/scheduler.sh --dry-run   # phải thấy: + ... create http uniai-monthly-report-staging (và -production nếu đã deploy)
bash infra/scheduler.sh
gcloud scheduler jobs run uniai-monthly-report-staging --location=asia-southeast1
```

Sau ~1 phút: Firestore database `staging` → collection `monthlyReports` có tài liệu tháng trước (có thể toàn số 0).

## Bước 2 – Kiểm tra trên staging

1. Super Admin → tab **Báo cáo**: mặc định tháng trước; ô tổng, bảng đơn vị (thụt lề theo cây, ngân sách, định mức đã
   cấp, % ngân sách), model / nhà cung cấp / nhóm model. Chọn tháng này → dòng "Số liệu tạm tính".
2. Bấm **Lưu báo cáo tháng** (tháng này) → thông báo đã lưu, dòng chú thích đổi thành "Báo cáo tạm tính, tạo lúc…".
3. **Tải Excel** → mở bằng Excel/Google Sheets: 7 sheet, số tiền dạng 0.00, có hàng tiêu đề đậm.
4. Unit Admin (tài khoản có `scopeDepartmentId`): tab Báo cáo chỉ thấy đơn vị mình và đơn vị con; tệp Excel tên
   `bao-cao-ai-<kỳ>-<mã đơn vị>.xlsx`, sheet Người dùng chỉ có người trong đơn vị.
5. Unit Admin → tab **Định mức** → đặt ngân sách cho một đơn vị con **lớn hơn** ngân sách đơn vị mình → báo lỗi "Vượt
   ngân sách của đơn vị cha…"; trong hạn mức → thành công.
6. Auditor → Nhật ký: có `REPORT_EXPORT` (kỳ, phạm vi) cho mỗi lần tải.

## Bước 3 – Load Balancer cho API (khi có D10)

Ví dụ tên miền API `api.ai.ftu.edu.vn` (thay bằng tên miền đã chốt):

```bash
bash infra/domain.sh --api-domain api.ai.ftu.edu.vn --env production --dry-run
bash infra/domain.sh --api-domain api.ai.ftu.edu.vn --env production
```

Script in **địa chỉ IP**. Gửi Phòng CNTT tạo bản ghi `api.ai.ftu.edu.vn  A  <IP>`. Chờ chứng chỉ ACTIVE (15–60 phút):

```bash
gcloud compute ssl-certificates list --global --format='table(name,managed.status,managed.domainStatus)'
curl -sS https://api.ai.ftu.edu.vn/health
```

(Muốn thử trước trên staging: `--env staging` với một tên miền con khác, ví dụ `api-staging.ai.ftu.edu.vn`.)

## Bước 4 – Tên miền web (Firebase Hosting, console)

1. Firebase console → Hosting → site `uniaiplatform1` → **Add custom domain** → ví dụ `ai.ftu.edu.vn` → làm theo
   hướng dẫn (bản ghi TXT xác minh + A/CNAME do Phòng CNTT tạo). Chờ trạng thái **Connected** và chứng chỉ.
2. Firebase console → Authentication → Settings → **Authorized domains** → thêm `ai.ftu.edu.vn`.
3. Báo Claude Code tên miền web để thêm `https://ai.ftu.edu.vn` vào `infra/storage-cors.json` (PR); sau khi merge chạy
   `bash infra/storage.sh` (tải tệp đính kèm từ tên miền mới).

## Bước 5 – Bật tên miền trong deploy

GitHub → Settings → Environments → `production` → **Environment variables**:

- `WEB_CUSTOM_DOMAIN` = `ai.ftu.edu.vn` (thêm vào CORS của API)
- `API_CUSTOM_DOMAIN` = `api.ai.ftu.edu.vn` (web gọi API qua tên miền này)

Deploy lại production (tag `v*` mới do Chủ dự án duyệt, hoặc Actions → Deploy → Run workflow → production). Trong log
bước "Build web…" phải thấy `Web gọi API tại https://api.ai.ftu.edu.vn`; nếu thấy cảnh báo "chưa trả về phiên
bản" thì chứng chỉ/DNS chưa xong – web vẫn chạy bằng địa chỉ run.app, deploy lại sau.

Kiểm tra: mở `https://ai.ftu.edu.vn`, đăng nhập, chat một câu (DevTools → Network: yêu cầu `/api/ai/chat` tới
`api.ai.ftu.edu.vn`, stream chữ bình thường), tải một tệp đính kèm.

## Rollback

- Báo cáo: tắt job `gcloud scheduler jobs pause uniai-monthly-report-<env> --location=asia-southeast1`.
- Tên miền: xóa biến `API_CUSTOM_DOMAIN` của environment rồi deploy lại → web quay về run.app. Load Balancer có thể
  giữ nguyên (không ảnh hưởng) hoặc xóa các tài nguyên `uniai-api-*` tạo ở bước 3 (chi phí Load Balancer ~18 USD/tháng).

## Báo cáo

Bình luận vào Issue "Deploy M16": kết quả bước 1–2; bước 3–5 (IP, trạng thái chứng chỉ, tên miền đã bật) hoặc "chờ
D10".
