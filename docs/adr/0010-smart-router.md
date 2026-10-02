# ADR 0010 – Smart Router (định tuyến AUTO theo luật)

- Trạng thái: Đã chấp nhận (M11, 02/10/2026)

## Bối cảnh

Đặc tả 8.6 và 13.2 (M11): AUTO chọn model rẻ nhất đủ dùng theo bộ luật cấu hình được, ghi lý do định tuyến, có
tỷ lệ mục tiêu theo nhóm model, hạ cấp khi hết hạn mức Advanced; bộ 100 câu mẫu đạt ≥ 85 %.

## Quyết định

1. **Luật** trong `settings/router` (`routerConfigSchema`, `packages/shared/src/router.ts`): mỗi luật có nhóm đích
   (Tiết kiệm/Tiêu chuẩn/Nâng cao), độ ưu tiên, từ khóa (so khớp nguyên từ, bỏ dấu, không phân biệt hoa thường),
   độ dài tối thiểu/tối đa (câu hỏi + văn bản tệp), có tệp / có ảnh. Luật bật có ưu tiên cao nhất khớp mọi điều kiện
   thắng; không luật nào khớp → nhóm mặc định. Không gọi AI để phân loại (không tốn tiền, quyết định tức thì).
2. **Chọn model**: nhóm đã phân loại trước, không có model dùng được thì sang nhóm gần nhất (ưu tiên nhóm rẻ hơn);
   lý do ghi rõ cả việc chuyển nhóm. Lý do hiện cho người dùng (sự kiện `meta`), lưu sổ cái (`routeReason`) và
   audit `MODEL_ROUTED`.
3. **Tỷ lệ mục tiêu** (mặc định 70/25/5): trang Định tuyến so với tỷ lệ thực tế tháng này (từ `usageAggregates`).
   Bật `enforceTargets`: khi nhóm Nâng cao vượt mục tiêu > 5 điểm (sau 100 yêu cầu trong tháng), yêu cầu được
   phân loại Nâng cao chuyển sang Tiêu chuẩn.
4. **Hết hạn mức Nâng cao/Cao cấp** (cả AUTO lẫn chọn tay): hạ xuống các nhóm rẻ hơn theo cùng quyết định.
5. Cấu hình cache 30 giây mỗi instance, lưu là áp dụng ngay trên instance đó; audit `ADMIN_CHANGE`.

## Hệ quả

- Bộ luật mặc định là điểm khởi đầu; Trường thay bằng 100 câu hỏi thật của mình (thêm vào
  `packages/shared/src/router.test.ts`) và chỉnh từ khóa trên trang Định tuyến.
- Phân loại theo từ khóa có giới hạn; có thể bổ sung bộ phân loại bằng model rẻ ở giai đoạn sau nếu cần.
