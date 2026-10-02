# Runbook M13 – RAG trong chat (trích dẫn, phân quyền)

Người thực hiện: **Claude Cowork** (trình duyệt). Thiết kế: ADR 0012. **Không có thao tác hạ tầng**, không có bước
KHÔNG ĐẢO NGƯỢC.

## Điều kiện trước

- PR M13 đã merge, Deploy (staging) xanh; M12 đã ĐẠT (có kho với tài liệu **Sẵn sàng**).
- Tài khoản thử của 2 khoa khác nhau (ví dụ A thuộc khoa KTQT, B thuộc khoa QTKD) trên staging.

## Bước 1 – Trích dẫn

Tài khoản A: chat → **📚 Kho tri thức** → chọn kho "Quy chế đào tạo" → hỏi một câu có trong quy chế. Câu trả lời
có [1], [2]… và mục **Nguồn từ kho tri thức** đúng văn bản, phiên bản, trang. Tải lại trang: hội thoại vẫn giữ
kho đã chọn và nguồn.

## Bước 2 – Phân quyền (bắt buộc)

1. AI Admin tạo kho thử "Nội bộ KTQT" (phạm vi khoa KTQT), nạp 1 văn bản thử (không mật).
2. Tài khoản A thấy kho này trong danh sách; tài khoản B **không** thấy.
3. B không thể dùng kho này (mọi cách thử đều bị từ chối, không trả nội dung).
4. Tắt kho → A cũng không thấy nữa.

## Bước 3 – Bộ 50 câu hỏi quy chế

Chủ dự án/phòng Quản lý đào tạo cung cấp 50 câu hỏi kèm văn bản đúng. Cowork hỏi lần lượt, ghi tỷ lệ câu có nguồn
[1] đúng văn bản (mục tiêu ≥ 90 %). Gửi danh sách câu hỏi (không dữ liệu cá nhân) vào Issue để đưa vào test.

## Rollback

Tắt kho trên trang **Kho tri thức**; người dùng vẫn chat bình thường không có kho.

## Báo cáo

Bình luận vào Issue "Deploy M13": kết quả bước 1–3.
