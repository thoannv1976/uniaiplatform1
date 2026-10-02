# Checklist go-live pilot (v1.0.0)

Đánh dấu trong Issue "Deploy M10". Người làm: Cowork (C), Chủ dự án (O), Claude Code (CC).

## Trước khi deploy production

- [ ] (CC) M0–M10 đã merge, CI xanh, staging deploy xanh.
- [ ] (C) Runbook M4–M9 đã chạy trên staging và đạt (Issue Deploy M4…M9 đã đóng).
- [ ] (C) `infra/hardening.sh` đã chạy: PITR + backup hằng ngày cho cả 2 database, log bucket `uniai-audit` + sink,
      cảnh báo tỷ lệ lỗi > 5 %.
- [ ] (C) Diễn tập rollback trên staging thành công (RUNBOOK-VAN-HANH mục 3): chuyển traffic về revision trước rồi
      trả lại.
- [ ] (C) Diễn tập kill switch trên staging: tắt toàn bộ → chat báo "Hệ thống AI đang tạm dừng" trong < 5 giây → bật lại.
- [ ] (O) Chốt D9 (nhóm pilot), D10 (tên miền: dùng `*.web.app`), D7 (ngân sách Billing) trong `docs/QUYET_DINH.md`.
- [ ] (O) Phê duyệt cổng G-Pilot.

## Deploy production

- [ ] (C/O) Tạo tag `v1.0.0` trên `main` → workflow Deploy (production) → (O) **Approve** trong environment `production`.
- [ ] (C) `bash infra/scheduler.sh` (thêm job production cho worker `uniai-worker`).
- [ ] (C) `pnpm ops:grant-role --email <super-admin>@ftu.edu.vn --role super_admin --database '(default)'`.
- [ ] (Super Admin, production) Đơn vị: nhập CSV cây đơn vị. Model & giá: **Nạp danh mục mẫu**, bật các model dùng
      cho pilot, kiểm tra giá. Nhà cung cấp: nhập key OpenAI (production), xác nhận Vertex AI.
      `pnpm ops:smoke-providers --database '(default)'` – mỗi model trả lời, có token/chi phí.
- [ ] (Super Admin) Định mức: nhóm định mức, ngân sách toàn trường (FTU) và các đơn vị pilot; tỷ giá; Kill switch:
      phanh khẩn cấp 100 %.
- [ ] (Super Admin) Cán bộ: nhập CSV 50–100 người pilot (vai trò `user`, đơn vị) + Unit Admin các khoa pilot.
- [ ] (C) Kiểm tra production: `/health`, đăng nhập Google `@ftu.edu.vn`, đồng ý điều khoản, chat AUTO, đính kèm PDF,
      Mức sử dụng, tab Thống kê sau 5 phút, chuông thông báo.
- [ ] `ENABLE_MOCK_PROVIDER=false` trên production (deploy.yml tự đặt) – model Mock không hiện.

## Sau go-live (tuần đầu)

- [ ] Theo dõi hằng ngày: tab Thống kê, log `provider_error`, cảnh báo email.
- [ ] Thu phản hồi người dùng pilot; ghi Issue cho lỗi/đề xuất.
- [ ] (O) Sau khi ổn định: xác nhận khóa retention log audit (RUNBOOK-VAN-HANH mục 8).
