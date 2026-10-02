# Runbook M10 – Hoàn thiện và go-live pilot

Người thực hiện: **Claude Cowork** (Cloud Shell + trình duyệt); Chủ dự án duyệt production. Thiết kế: ADR 0009.
Checklist đầy đủ: `docs/deploy/GO-LIVE-CHECKLIST.md`; vận hành: `docs/deploy/RUNBOOK-VAN-HANH.md`.

⚠ Bước KHÔNG ĐẢO NGƯỢC: khóa retention log bucket `uniai-audit` – **không** nằm trong runbook này, chỉ làm theo
RUNBOOK-VAN-HANH mục 8 khi Chủ dự án xác nhận riêng.

## Điều kiện trước

- PR M10 đã merge, Deploy staging xanh. Runbook M8, M9 đã làm.

## Bước 1 – Hardening (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/hardening.sh --dry-run
ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/hardening.sh
gcloud firestore databases describe --database='(default)' --format='value(pointInTimeRecoveryEnablement)'
gcloud firestore backups schedules list --database='(default)'
```

## Bước 2 – Kiểm tra tính năng M10 trên staging

1. Đăng nhập tài khoản mới (hoặc tài khoản đã có): màn hình **Điều khoản sử dụng** → đánh dấu → **Đồng ý** → vào chat.
2. **Kill switch** (Super Admin): tắt toàn bộ, lý do "Diễn tập" → ở tab khác gửi chat → trong < 5 giây nhận "Hệ thống AI
   đang tạm dừng. Lý do: Diễn tập" → **Bật lại toàn bộ AI** → chat lại được. Tắt riêng nhà cung cấp Mock → AUTO dùng
   model khác (nếu có) hoặc báo tạm dừng.
3. **Audit** (Auditor/Super Admin → Nhật ký): có `AI_REQUEST`, `MODEL_ROUTED`, `ADMIN_CHANGE` (kill switch),
   `TERMS_ACCEPTED`; không có nội dung tin nhắn.

## Bước 3 – Diễn tập rollback trên staging

Theo RUNBOOK-VAN-HANH mục 3 với `uniai-api-staging`: chuyển 100 % traffic về revision trước, kiểm tra `/health`,
chuyển lại revision mới nhất (`--to-latest`). Ghi thời gian thực hiện vào Issue.

## Bước 4 – Production (sau khi Chủ dự án phê duyệt G-Pilot)

Làm theo GO-LIVE-CHECKLIST mục "Deploy production": tag `v1.0.0`, Approve, `infra/scheduler.sh`, cấp Super Admin,
cấu hình đơn vị/model/key/định mức, nhập danh sách pilot, kiểm tra end-to-end.

## Tiêu chí ĐẠT

- PITR + backup hằng ngày bật cho 2 database; log bucket audit + sink; cảnh báo lỗi > 5 %.
- Kill switch có hiệu lực < 5 giây; rollback diễn tập thành công.
- Production: mọi DoD M0–M9 đạt; nhóm pilot đăng nhập và dùng được.

## Báo cáo

Bình luận vào Issue "Deploy M10" theo checklist; kèm thời gian diễn tập rollback và kill switch.
