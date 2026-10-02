# ADR 0012 – RAG trong chat: phân quyền và trích dẫn

- Trạng thái: Đã chấp nhận (M13, 02/10/2026)

## Bối cảnh

Đặc tả 8.9 và 13.2 (M13): chat tìm đoạn văn bản trong kho tri thức theo phạm vi ACL, gộp/xếp hạng, trích dẫn nguồn;
test rò rỉ ACL; 50 câu hỏi quy chế ≥ 90 % trích đúng nguồn.

## Quyết định

1. **Chọn kho trong chat**: người dùng bật nút **📚 Kho tri thức** và chọn tối đa 5 kho; lựa chọn lưu trên hội thoại
   (`conversations.knowledgeBaseIds`). `GET /api/knowledge-bases` chỉ trả kho người dùng được dùng.
2. **ACL trước khi tìm**: kho đang bật, phạm vi `null` (toàn trường) hoặc đơn vị nằm trên `departmentPath` của
   người dùng (đơn vị con thấy kho của đơn vị cha). Super Admin và AI Admin thấy mọi kho (để kiểm tra). Yêu cầu
   có kho ngoài quyền → **403**, không truy vấn vector nào chạy.
3. **Tìm và xếp hạng**: embedding câu hỏi (`RETRIEVAL_QUERY`) → `findNearest` (COSINE, 8 đoạn) trên từng kho được
   phép → gộp theo khoảng cách, bỏ đoạn khoảng cách > 0,85, giới hạn 24.000 ký tự.
4. **Đưa vào model**: khối "Tài liệu tham khảo…" đánh số [1], [2]… (tiêu đề, phiên bản, ngày hiệu lực, trang) đặt
   trước câu hỏi, yêu cầu ghi nguồn dạng [n] và nói rõ khi không đủ căn cứ. Không có đoạn liên quan → nói rõ không
   có căn cứ trong văn bản của Trường. Tin nhắn lưu đúng câu người dùng gõ (không lưu khối tài liệu).
5. **Trích dẫn**: sự kiện SSE `citations` (sau `meta`), lưu vào câu trả lời (`messages.citations`), hiện mục
   **Nguồn từ kho tri thức** dưới câu trả lời.
6. Embedding câu hỏi không ghi sổ cái (rất nhỏ); token của khối tài liệu tính vào chi phí câu trả lời như bình thường.

## Hệ quả

- Hỏi tiếp tìm lại theo câu hỏi mới (không mang theo đoạn của lượt trước).
- Ngưỡng 0,85 và số đoạn là hằng số; chỉnh sau khi đo trên bộ câu hỏi thật của Trường.
