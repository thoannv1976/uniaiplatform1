# ADR 0015 – Báo cáo tháng, xuất Excel, tên miền riêng

- Trạng thái: Đã chấp nhận (M16, 02/10/2026)

## Bối cảnh

Đặc tả 8.13, 10 và 13.2 (M16): Unit Admin phân bổ ngân sách trong đơn vị (không vượt ngân sách đơn vị cha), báo
cáo tháng, xuất Excel; kế hoạch build mục 6: tên miền riêng qua Load Balancer (D10), báo cáo tháng đầu.

## Quyết định

1. **Phân bổ ngân sách** giữ như M7 (`QuotaService.setBudget`, transaction): Unit Admin chỉ đặt ngân sách cho đơn
   vị con trong phạm vi; tổng ngân sách các con không vượt ngân sách cha, ngân sách không thấp hơn tổng của các con
   và định mức đã cấp. M16 bổ sung test API cho trường hợp Unit Admin phân bổ vượt đơn vị cha (400).
2. **Báo cáo tháng** `monthlyReports/{YYYYMM}` dựng **từ `usageAggregates`** (không quét sổ cái), kèm ngân sách
   và định mức đã cấp của từng đơn vị (`budgetPeriods`), tỷ giá hiển thị. Worker `/jobs/monthly-report` chạy 01:15
   ngày 1 (Cloud Scheduler `uniai-monthly-report-*`): gộp nốt sổ cái (cùng cơ chế `_checkpoint`) rồi lưu báo cáo
   tháng vừa kết thúc (`final: true`). Báo cáo là dữ liệu dẫn xuất nên được ghi đè khi chạy lại; Super Admin có nút
   "Tạo lại báo cáo" (`POST /api/admin/reports/monthly`, audit `ADMIN_CHANGE`). Tháng chưa có báo cáo lưu được
   tính tại chỗ (`stored: false`, ghi "tạm tính").
3. **Phạm vi**: `GET /api/reports/monthly` cho Super Admin, AI Admin, Auditor (toàn trường) và Unit Admin (chỉ
   đơn vị mình và các đơn vị con: tổng, model, nhà cung cấp, ngày tính lại từ `departmentModels`/`departmentDays`
   lưu kèm báo cáo, `scopeReport` trong `packages/shared/src/reports.ts`).
4. **Excel**: `GET /api/reports/export?period=&format=xlsx` (Super Admin, Auditor, Unit Admin theo phạm vi), 7 sheet
   (Tổng quan, Đơn vị, Model, Nhà cung cấp, Nhóm model, Theo ngày, Người dùng). Tự viết bộ ghi OOXML tối giản
   (`apps/api/src/reports/xlsx.ts`, nén bằng `fflate` đã có trong repo) thay vì thư viện lớn: chỉ ô chữ (inline
   string, không công thức → không có rủi ro CSV/formula injection) và ô số với định dạng `0.00`, `#,##0`, `0.0`.
   Mỗi lần xuất ghi audit `REPORT_EXPORT` (kỳ, phạm vi). Sheet "Người dùng" chỉ có chi phí/định mức, không có nội
   dung hội thoại. CSV của M8 giữ nguyên.
5. **Tên miền riêng (D10)**: `infra/domain.sh` tạo global external Application Load Balancer: IP tĩnh, serverless
   NEG → `uniai-api[-staging]`, chứng chỉ Google quản lý, chuyển HTTP → HTTPS. SSE đi qua Load Balancer được (thời
   gian tối đa do Cloud Run quyết định, 900 giây). Web vẫn trên Firebase Hosting, thêm tên miền trong console.
   `deploy.yml` đọc biến theo Environment: `WEB_CUSTOM_DOMAIN` (thêm vào `WEB_ORIGINS`) và `API_CUSTOM_DOMAIN`.
   Web chỉ chuyển sang tên miền API riêng khi `https://<API_CUSTOM_DOMAIN>/health` trả đúng phiên bản vừa deploy,
   nếu không thì giữ địa chỉ `run.app` và báo cảnh báo. `run.app` vẫn mở (smoke test, dự phòng); khóa ingress
   Cloud Run chỉ cho Load Balancer là việc tùy chọn về sau.

## Hệ quả

- Báo cáo tháng phụ thuộc job tổng hợp 5 phút; nếu tháng trước có giao dịch quyết toán muộn (sweeper), chạy lại
  "Tạo lại báo cáo" sẽ cập nhật số liệu.
- Bộ ghi Excel chỉ hỗ trợ những gì báo cáo cần; cần biểu đồ trong Excel thì dùng thư viện ở giai đoạn sau.
- Tên miền riêng cần Phòng CNTT tạo bản ghi DNS; origin web mới phải thêm vào `infra/storage-cors.json` (PR) để tải
  tệp qua signed URL.
