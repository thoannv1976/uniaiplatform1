# ADR 0007 – Thống kê chi phí, dashboard và cảnh báo

- Trạng thái: Đã chấp nhận (M8, 02/10/2026)

## Bối cảnh

Đặc tả 8.13: dashboard chi phí toàn trường và theo đơn vị (cập nhật ~5 phút), "Mức sử dụng của tôi", cảnh báo
80 % định mức người dùng, 80 % ngân sách đơn vị, 50/70/80/90/100 % ngân sách trường, dự báo vượt ngân sách,
hiển thị VND tham khảo. Không được đọc toàn bộ sổ cái mỗi lần mở dashboard, và không ghi số liệu đơn vị theo
từng yêu cầu (ADR 0006).

## Quyết định

1. **Tổng hợp tăng dần, đúng một lần**: job `/jobs/usage-aggregate` (worker, 5 phút) đọc `usageTransactions`
   `committed` theo thứ tự `(committedAt, id)` sau mốc `usageAggregates/_checkpoint`, tối đa 400 bản ghi/lô, và
   ghi tổng + mốc mới **trong cùng một transaction** (`UsageAggregator`, `packages/firestore/src/aggregate.ts`).
   Chạy trùng hay chạy lại không cộng hai lần. Bản ghi commit < 30 giây để lần sau (đồng hồ ổn định).
2. **Hình dạng tổng**: `usageAggregates/{YYYYMM}` (theo nhà cung cấp, model, nhóm model, đơn vị – cộng cho mọi
   đơn vị tổ tiên –, đơn vị × model, người dùng) và `…/days/{YYYYMMDD}` (ngày theo giờ VN, người dùng hoạt động).
   Sau mỗi lần chạy, chép chi phí đơn vị vào `budgetPeriods.usedAggregate`.
3. **Dashboard** (`GET /api/admin/dashboard`) chỉ đọc tổng; Unit Admin luôn bị ép về đơn vị của mình.
   **Mức sử dụng của tôi** (`GET /api/me/usage`) đọc thẳng sổ cái của chính người đó (ít bản ghi, luôn mới).
4. **Dự báo** cuối tháng = đã chi + trung bình 7 ngày gần nhất × số ngày còn lại (`forecastPeriod`).
5. **Cảnh báo**: `alertStates/{khóa}` được `create()` trước → mỗi ngưỡng chỉ gửi một lần mỗi kỳ; thông báo vào
   `notifications` (chuông trên giao diện) và ghi log JSON `"alert": true` để Cloud Monitoring gửi email
   (`infra/alerts.sh`). Cảnh báo 80 % định mức người dùng chạy ngay sau commit trên đường chat (không chặn trả lời).
6. **VND** chỉ để hiển thị: tỷ giá trong `settings/app.exchangeRateVndPerUsd` (mặc định 26.000), Super Admin
   sửa, ghi audit. Mọi phép tính vẫn bằng micro-USD nguyên.
7. **Ngân sách GCP** (D7): Cloud Billing budget 30.000.000 ₫/tháng, ngưỡng 50/90/100 % (`infra/billing-budget.sh`).
   **BigQuery** là tùy chọn: dataset `uniai_analytics` + extension Stream Firestore to BigQuery cho sổ cái.

## Hệ quả

- Dashboard trễ tối đa ~5,5 phút; "Mức sử dụng của tôi" và định mức luôn tức thời.
- Bản ghi `committed` đến muộn hơn mốc (commit sau khi job đã đi qua thời điểm đó) không xảy ra trong thực tế vì
  `committedAt` do máy chủ Firestore gán và job bỏ qua 30 giây gần nhất.
- Đổi đơn vị của một người không chuyển chi phí cũ sang đơn vị mới (sổ cái giữ `departmentPath` lúc phát sinh).
