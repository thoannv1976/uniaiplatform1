# Runbook M14 – Thư viện prompt, Dự án, Tệp của tôi

Người thực hiện: **Claude Cowork** (trình duyệt). Thiết kế: ADR 0013. **Không có thao tác hạ tầng**, không có bước
KHÔNG ĐẢO NGƯỢC.

## Điều kiện trước

- PR M14 đã merge, Deploy (staging) xanh. Tài khoản AI Admin, Unit Admin (một khoa) và người dùng thường.

## Bước 1 – Prompt

1. Người dùng: **Không gian làm việc** → tab Prompt → tạo prompt riêng có biến (ví dụ "Soạn đề cương môn
   {{tên môn}}"). Trong chat: **📝 Prompt** → chọn → điền biến → **Chèn** → gửi.
2. AI Admin: tạo prompt **Chia sẻ cho đơn vị** cho một khoa → người dùng khoa đó thấy (không sửa được), người khoa
   khác không thấy. Prompt chia sẻ không chọn đơn vị → toàn trường thấy.
3. Unit Admin: chỉ chia sẻ được cho đơn vị trong khoa mình.
4. Nhật ký: `ADMIN_CHANGE` với `publish_prompt`.

## Bước 2 – Dự án và tệp

1. Đính kèm 1–2 tệp trong chat (để có trong **Tệp của tôi**).
2. Tạo dự án, nhập chỉ dẫn, chọn tệp → **Chat trong dự án** → câu trả lời theo chỉ dẫn và nội dung tệp; hỏi tiếp
   vẫn giữ ngữ cảnh. Bộ lọc **Dự án** ở danh sách hội thoại chỉ hiện hội thoại của dự án.
3. Xóa dự án → hội thoại vẫn còn (không thuộc dự án nào).

## Bước 3 – Nhập prompt mẫu của các khoa

Thu prompt mẫu do các khoa cung cấp (không chứa dữ liệu cá nhân), AI Admin nhập và chia sẻ cho đúng đơn vị. Ghi số
lượng vào Issue.

## Rollback

Xóa prompt dùng chung không đúng; không cần deploy.

## Báo cáo

Bình luận vào Issue "Deploy M14": kết quả bước 1–3.
