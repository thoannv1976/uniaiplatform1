# ADR 0013 – Không gian làm việc: thư viện prompt, dự án, tệp của tôi

- Trạng thái: Đã chấp nhận (M14, 02/10/2026)

## Bối cảnh

Đặc tả 8.10 và 13.2 (M14): Prompt Library, Projects (nhóm hội thoại + tệp + chỉ dẫn riêng), My Files, My Prompts;
AI Admin publish prompt tới đơn vị; người dùng dùng prompt có biến.

## Quyết định

1. **Prompt** (`prompts/{id}`): tiêu đề, mô tả, nhóm, nội dung có biến `{{tên biến}}` (`extractVariables`,
   `fillPrompt` trong `packages/shared/src/workspace.ts`), `visibility` riêng/dùng chung, `publishedTo` (đơn vị;
   rỗng = toàn trường). Người dùng chỉ tạo prompt riêng. AI Admin/Super Admin chia sẻ toàn trường hoặc đơn vị bất kỳ;
   Unit Admin chỉ chia sẻ cho đơn vị trong phạm vi mình. Người dùng thấy prompt của mình + prompt chia sẻ cho toàn
   trường hoặc đơn vị trên `departmentPath`. Chia sẻ/sửa/xóa prompt dùng chung ghi audit `ADMIN_CHANGE`.
2. **Dự án** (`projects/{id}`, chỉ chủ sở hữu): tên, chỉ dẫn, tối đa 10 tệp (tệp chat đã xử lý). Hội thoại có
   `projectId`; chỉ dẫn và văn bản tệp của dự án được thêm vào system prompt của mọi lượt (tệp tối đa 1/4 cửa sổ ngữ
   cảnh). Xóa dự án giữ hội thoại (bỏ khỏi dự án).
3. **Tệp của tôi**: `GET /api/files` liệt kê tệp chat đã xử lý của chính người dùng (vẫn tự xóa sau 180 ngày, ADR
   0008); xóa được; chọn làm tệp dự án.
4. **Giao diện**: trang **Không gian làm việc** (3 tab); trong chat có nút **📝 Prompt** (điền biến rồi chèn) và bộ
   lọc **Dự án** ở danh sách hội thoại (hội thoại mới tạo trong dự án đang lọc, đường dẫn `/?du-an=<id>`).

## Hệ quả

- Prompt dùng chung không có phiên bản; sửa là áp dụng ngay cho mọi người.
- Ảnh trong tệp dự án không đưa vào system prompt (chỉ văn bản).
