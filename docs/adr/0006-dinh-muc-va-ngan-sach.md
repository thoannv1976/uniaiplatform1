# ADR 0006 – Định mức, ngân sách và sổ cái (reserve/commit)

- Trạng thái: Đã chấp nhận (M7, 02/10/2026)

## Bối cảnh

Đặc tả 8.7: không để chi tiêu AI vượt định mức người dùng, ngân sách đơn vị và ngân sách trường, mà không tạo
"điểm nóng" ghi trên Firestore (≤ 1 lần ghi/giây trên một tài liệu).

## Quyết định

1. **Một tài liệu mỗi người mỗi tháng** `quotaPeriods/{uid}_{YYYYMM}` (tháng theo giờ Việt Nam). Mỗi yêu cầu AI
   chỉ ghi tài liệu này, trong transaction của `QuotaService` (`packages/firestore/src/quota.ts`).
2. **Reserve → commit**: trước khi gọi nhà cung cấp, giữ chi phí xấu nhất = token vào ước tính (~3 ký tự/token)
   - token ra tối đa. Nếu không đủ, giảm token ra tối đa cho vừa phần còn lại (không dưới 1.024); vẫn không đủ →
     **402** tiếng Việt. Sau khi trả lời: trả phần giữ, cộng chi phí thật; bản ghi `usageTransactions` chuyển
     `reserved → committed`. Không có token (lỗi trước khi sinh) → `released`, không tính tiền.
3. **Hạn mức model cao cấp** (nhóm Nâng cao và Cao cấp) là hạn mức con. Hết hạn mức khi người dùng tự chọn model
   cao cấp → tự chuyển sang AUTO (không chọn model cao cấp) và ghi lý do; không còn model rẻ hơn → 402.
4. **Giới hạn tốc độ** theo nhóm định mức (yêu cầu/phút) trong cùng transaction → **429** + `Retry-After`.
5. **Ngân sách đơn vị** `budgetPeriods/{deptId}_{YYYYMM}` chỉ là trần **phân bổ**: tăng định mức một người bị từ
   chối nếu làm Σ định mức cán bộ của bất kỳ đơn vị tổ tiên có ngân sách vượt ngân sách đó; ngân sách đơn vị không
   thấp hơn tổng đã phân bổ và tổng ngân sách đơn vị con, và cùng các đơn vị anh em không vượt đơn vị cha.
   Không ghi số liệu đơn vị theo từng yêu cầu; `usedAggregate` do job tổng hợp (M8) cập nhật.
6. **Điều chỉnh** (`quotaAdjustments`) bắt buộc lý do + người phê duyệt, ghi audit `QUOTA_CHANGE`; ngân sách ghi
   `BUDGET_CHANGE`. Cấp tạm có `expiresAt`, job tự thu hồi. Unit Admin chỉ điều chỉnh người dùng thường trong
   đơn vị mình và chỉ phân bổ ngân sách cho đơn vị con.
7. **Nhóm định mức** mặc định theo đặc tả 17 (Tiêu chuẩn $2/$0,5, Sử dụng nhiều $5/$1, Nghiên cứu $20/$5; 10/20/30
   yêu cầu/phút); Super Admin sửa trong `quotaTiers`, áp dụng cho kỳ mở sau.
8. **Job (uniai-worker, Cloud Scheduler OIDC, `infra/scheduler.sh`)**: mở kỳ ngày 1 hằng tháng (00:05 giờ VN);
   mỗi 5 phút hoàn trả phần giữ quá 10 phút (instance chết giữa chừng) và thu hồi cấp tạm hết hạn. Commit đến muộn
   vẫn ghi đúng chi phí.

## Hệ quả

- Hai admin tăng định mức đồng thời trong cùng đơn vị có thể cùng thấy "còn chỗ" (tổng đọc trong transaction nhưng
  khác tài liệu); thao tác hiếm, chênh lệch nhỏ, báo cáo ngân sách hiển thị "đã phân bổ" để phát hiện.
- Người mới được cấp định mức mặc định khi dùng lần đầu, kể cả khi đơn vị đã hết ngân sách phân bổ; dashboard (M8)
  cảnh báo khi đã phân bổ > ngân sách.
