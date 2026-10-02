# Runbook M8 – Thống kê chi phí, dashboard, cảnh báo

Người thực hiện: **Claude Cowork** (Cloud Shell + trình duyệt). Thiết kế: ADR 0007.
Không có bước nào KHÔNG ĐẢO NGƯỢC được. Không dán API key hay mật khẩu vào Issue/chat.

## Điều kiện trước

- PR M8 đã merge, workflow **Deploy** (staging) xanh (deploy tự áp dụng 2 index mới của `usageTransactions`).
- Đã làm runbook M7 (Cloud Scheduler).

## Bước 1 – Job tổng hợp (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/scheduler.sh --dry-run   # thêm job uniai-usage-aggregate-staging (5 phút)
bash infra/scheduler.sh
gcloud scheduler jobs run uniai-usage-aggregate-staging --location=asia-southeast1
```

Kiểm tra: Cloud Run → `uniai-worker-staging` → Logs có `"job":"usage-aggregate"` với `added` ≥ 0, không có lỗi
`FAILED_PRECONDITION` (thiếu index). Nếu có lỗi index: Firestore → Indexes, chờ index `usageTransactions`
(status, committedAt) chuyển **Enabled** (vài phút) rồi chạy lại job.

## Bước 2 – Kiểm tra trên staging (trình duyệt)

1. Người dùng: chat vài câu → link **Mức sử dụng** trên thanh trên cùng: thấy đã dùng/định mức, theo model, theo ngày.
2. Sau ≤ 5 phút, Super Admin → **Trang quản trị** → tab **Thống kê**: tổng chi phí khớp tổng "Mức sử dụng" của các
   tài khoản thử; chọn **Phạm vi** một khoa → số liệu của khoa; tải **CSV theo đơn vị/model/người dùng**.
3. Super Admin đặt **Tỷ giá** (ví dụ 26000) → các số ₫ đổi theo.
4. Thử cảnh báo: tab **Định mức** → giảm định mức một tài khoản thử xuống gần mức đã dùng (lý do "Thử cảnh báo") →
   tài khoản đó chat một câu → chuông **Thông báo (1)** "Đã dùng 80% định mức…". Trả định mức như cũ.

## Bước 3 – Email cảnh báo (Cloud Shell)

Chủ dự án chọn hộp thư nhận cảnh báo (ví dụ hộp thư nhóm quản trị). Không dùng email cá nhân nếu không cần.

```bash
ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/alerts.sh --dry-run
ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/alerts.sh
```

## Bước 4 – Ngân sách GCP (D7, cần quyền Billing Account Administrator)

```bash
bash infra/billing-budget.sh --dry-run    # 30.000.000 VND/tháng, cảnh báo 50/90/100 %
bash infra/billing-budget.sh
```

Nếu tài khoản thanh toán tính bằng USD, script dừng và hướng dẫn: `BUDGET_AMOUNT=1150USD bash infra/billing-budget.sh`.
Không có quyền Billing → ghi vào Issue để Chủ dự án làm (Console → Billing → Budgets & alerts).

## Bước 5 – BigQuery (tùy chọn, có thể để sau go-live)

```bash
bash infra/bigquery.sh
```

Rồi Console → Firebase → Extensions → **Stream Firestore to BigQuery** → Install: vị trí BigQuery
`asia-southeast1`, Firestore database `staging` (sau này cài thêm bản cho `(default)`), collection path
`usageTransactions`, dataset `uniai_analytics`, table `usage_staging` (production: `usage`). Không bật
"wildcard"/sub-collection. Extension chỉ xuất sổ cái chi phí – không có nội dung hội thoại.

## Tiêu chí ĐẠT

- Job `uniai-usage-aggregate-staging` chạy 5 phút/lần, thành công; dashboard khớp tổng sổ cái.
- Unit Admin chỉ thấy đơn vị mình; xuất CSV chạy; cảnh báo 80 % hiện trên chuông.
- (Nếu làm bước 3–4) email xác minh kênh nhận được; budget `uniai-monthly` hiện trong Billing.

## Rollback

Tạm dừng job: `gcloud scheduler jobs pause uniai-usage-aggregate-staging --location=asia-southeast1`.
Tổng sai (không mong đợi): xóa `usageAggregates` (cả `_checkpoint`) trên database staging rồi chạy lại job – job tự
tính lại từ đầu sổ cái. Không bao giờ sửa/xóa `usageTransactions`.

## Báo cáo

Bình luận vào Issue "Deploy M8": kết quả bước 1–5, ảnh chụp tab Thống kê.
