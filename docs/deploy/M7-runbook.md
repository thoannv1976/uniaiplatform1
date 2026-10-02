# Runbook M7 – Định mức, ngân sách và job định kỳ

Người thực hiện: **Claude Cowork** (Cloud Shell + trình duyệt). Thiết kế: ADR 0006.
Không có bước nào KHÔNG ĐẢO NGƯỢC được.

## Điều kiện trước

- PR M7 đã merge, workflow **Deploy** (staging) xanh.
- Có Super Admin trên staging.

## Bước 1 – Cloud Scheduler (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/scheduler.sh --dry-run   # tạo SA uniai-scheduler, quyền invoker trên worker staging, 2 job staging
bash infra/scheduler.sh
gcloud scheduler jobs run uniai-reservation-sweeper-staging --location=asia-southeast1
gcloud scheduler jobs run uniai-quota-rollover-staging --location=asia-southeast1
```

Kiểm tra: Console → Cloud Scheduler: 2 job `*-staging` có lần chạy gần nhất **Success**. Console → Cloud Run →
`uniai-worker-staging` → Logs: có dòng `"job":"reservation-sweeper"` và `"job":"quota-rollover"`.
Production chưa có worker thì script tự bỏ qua; **chạy lại script sau lần deploy production**.

## Bước 2 – Kiểm tra định mức trên staging (trình duyệt)

1. Người dùng thường: màn hình chat hiện "Định mức tháng: còn $… / $2.00".
2. Super Admin → **Trang quản trị** → tab **Định mức**: thấy danh sách cán bộ, đã dùng/định mức.
3. Chọn một tài khoản thử → **Điều chỉnh** → Đặt lại, Định mức tháng, `0`, lý do, người duyệt → **Lưu điều chỉnh**.
   Tài khoản đó gửi chat → nhận thông báo "Bạn đã dùng hết định mức AI tháng này…". Đặt lại `2` để trả như cũ.
4. Gửi > 10 tin nhắn trong 1 phút bằng một tài khoản → thông báo "Bạn gửi quá nhanh…".
5. **Ngân sách đơn vị**: đặt ngân sách cho một khoa thấp hơn tổng định mức cán bộ → bị từ chối với lý do; đặt đủ → OK.

## Bước 3 – Định mức thật (Chủ dự án)

Chủ dự án xác nhận bảng nhóm định mức (mặc định theo Đặc tả mục 17) và ngân sách các đơn vị cho pilot. Super Admin
nhập ở tab **Định mức** (sửa nhóm, đặt ngân sách). Không cấp lớn ngay từ đầu.

## Tiêu chí ĐẠT

- Job Scheduler staging chạy thành công; hết hạn mức trên staging trả thông báo 402 tiếng Việt.
- `auditLogs` có `QUOTA_CHANGE` và `BUDGET_CHANGE` kèm lý do.

## Rollback

Tạm dừng job: `gcloud scheduler jobs pause <job> --location=asia-southeast1`. Định mức sai: điều chỉnh lại (có lý do).

## Báo cáo

Bình luận vào Issue "Deploy M7": kết quả bước 1–3, ảnh chụp tab Định mức (không có email người thật nếu không cần).
