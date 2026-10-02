# Runbook M11 – Smart Router

Người thực hiện: **Claude Cowork** (trình duyệt). Thiết kế: ADR 0010. **Không có thao tác hạ tầng**, không có bước
KHÔNG ĐẢO NGƯỢC.

## Điều kiện trước

- PR M11 đã merge, workflow Deploy (staging) xanh. Tài khoản AI Admin hoặc Super Admin trên staging.

## Bước 1 – Kiểm tra trên staging

1. Trang quản trị → tab **Định tuyến**: thấy 6 luật mặc định, tỷ lệ mục tiêu 70/25/5 và tỷ lệ thực tế tháng này.
2. Ô **Thử định tuyến**: "Viết hàm Python…" → Tiêu chuẩn; "Phân tích chuyên sâu…" → Nâng cao; "Thủ đô của Úc?" →
   Tiết kiệm; số ảnh = 1 → model đọc được ảnh.
3. Chat (AUTO) vài câu thuộc các nhóm trên: dòng lý do dưới câu trả lời nêu luật đã áp dụng.
4. Nhật ký (Auditor): có `MODEL_ROUTED` và `ADMIN_CHANGE` (khi lưu cấu hình).

## Bước 2 – Bộ câu hỏi thật của Trường

Chủ dự án/các khoa cung cấp 100 câu hỏi thường gặp kèm nhóm mong muốn (Tiết kiệm/Tiêu chuẩn/Nâng cao). Cowork
chạy từng câu trong ô **Thử định tuyến**, ghi tỷ lệ đúng; chỉnh từ khóa nếu < 85 %; gửi danh sách câu (không có dữ
liệu cá nhân) vào Issue để Claude Code đưa vào test tự động.

## Bước 3 – Theo dõi (sau 2 tuần, lặp lại hằng tháng)

So tỷ lệ thực tế với mục tiêu trên tab Định tuyến và chi phí trên tab Thống kê, báo cáo chi phí trước/sau M11.

## Rollback

Tắt từng luật (bỏ chọn **Bật**) hoặc đặt nhóm mặc định; không cần deploy.

## Báo cáo

Bình luận vào Issue "Deploy M11": kết quả bước 1, tỷ lệ đúng của bộ câu hỏi thật.
