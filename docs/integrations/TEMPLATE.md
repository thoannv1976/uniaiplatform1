# Đặc tả tích hợp: <Tên hệ thống> (`<mã>`)

> Sao chép tệp này thành `docs/integrations/<mã>.md`. Mã gồm chữ thường, số và `-`, 2–30 ký tự, ví dụ `lms`,
> `sis-dao-tao`. Điền mọi mục; mục không áp dụng thì ghi "Không áp dụng" kèm lý do. Không ghi token, mật khẩu hay
> dữ liệu thật của cán bộ/sinh viên vào tệp này.

- Trạng thái: Nháp | Chờ duyệt | Đã duyệt (ngày, người duyệt) | Ngừng
- Người soạn / đơn vị:
- Phiên bản đặc tả:

## 1. Mục đích

- Bài toán: agent cần dữ liệu gì, cho ai, để trả lời câu hỏi nào. Ghi 3–5 câu hỏi mẫu của người dùng.
- Đối tượng dùng: đơn vị, vai trò, số người dự kiến.
- Không làm: những gì nằm ngoài phạm vi (ví dụ: không xem điểm của sinh viên khác, không sửa dữ liệu).

## 2. Hệ thống nguồn

| Mục                                 | Nội dung |
| ----------------------------------- | -------- |
| Tên, phiên bản, nhà cung cấp        |          |
| Đơn vị chủ sở hữu dữ liệu           |          |
| Người phụ trách kỹ thuật            |          |
| Tài liệu API (đường dẫn, phiên bản) |          |
| Môi trường thử (staging/sandbox)    |          |
| Giờ bảo trì, SLA                    |          |

## 3. Mạng và xác thực

- Địa chỉ API production và staging. Phải là `https://`; ghi rõ API có ra Internet không. Nếu chỉ trong mạng nội
  bộ: phương án kết nối từ Cloud Run (`asia-southeast1`) là VPC connector, VPN hay cổng API công khai, và ai làm.
- Hạn chế IP nguồn (nếu có): Cloud Run không có IP cố định nếu không dùng Cloud NAT. Ghi yêu cầu.
- Cách xác thực:
  - `none`;
  - `bearer`;
  - `header` (tên header).
    Các cách khác (OAuth, mTLS…) cần làm thêm, ghi rõ.
- Tài khoản kỹ thuật: tên, quyền chỉ đọc nào, ai cấp, chu kỳ đổi token, cách thu hồi.
- `X-UniAI-Actor`:
  - hệ thống nguồn có dùng header này để lọc dữ liệu theo người hỏi không (khuyến nghị);
  - nếu không, nêu rủi ro: mọi người dùng agent đều đọc được cùng một phạm vi dữ liệu của tài khoản kỹ thuật.

## 4. Dữ liệu cá nhân và pháp lý

| Mục                                                          | Nội dung |
| ------------------------------------------------------------ | -------- |
| Các trường dữ liệu trả về (liệt kê đủ)                       |          |
| Trường nào là dữ liệu cá nhân / dữ liệu cá nhân nhạy cảm     |          |
| Cơ sở xử lý (Nghị định 13/2023/NĐ-CP, quy chế của Trường)    |          |
| Dữ liệu được gửi cho nhà cung cấp AI nào (theo Smart Router) |          |
| Chính sách DLP cần đặt (che/chặn loại nào)                   |          |
| Ý kiến bộ phận pháp chế/bảo vệ dữ liệu                       |          |

Nguyên tắc: thao tác chỉ trả **trường tối thiểu** cần cho câu hỏi. Ưu tiên API hoặc tham số lọc của hệ thống nguồn
để bỏ bớt trường, thay vì nhận cả bản ghi rồi trông vào DLP.

## 5. Thao tác (chỉ đọc)

Mỗi thao tác là một `GET`. Ghi đủ để cấu hình được và để model biết khi nào dùng.

| Mã thao tác  | Tên hiển thị       | Đường dẫn (dưới `baseUrl`) | Tham số (vị trí, kiểu, bắt buộc) | Khi nào agent dùng / trả về gì                       | Ví dụ phản hồi (ẩn danh) |
| ------------ | ------------------ | -------------------------- | -------------------------------- | ---------------------------------------------------- | ------------------------ |
| `get_course` | Thông tin học phần | `/courses/{courseId}`      | `courseId` (path, string, có)    | Hỏi về một học phần cụ thể: tên, tín chỉ, giảng viên | `{"name": "…"}`          |

Cấu hình dán vào Quản trị → Agent AI (để `"status": "disabled"` cho tới khi thử xong):

```json
{
  "name": "<Tên hiển thị>",
  "type": "lms | erp | sis | other",
  "description": "Theo docs/integrations/<mã>.md",
  "baseUrl": "https://<máy chủ>/<đường dẫn gốc>",
  "authType": "none | bearer | header",
  "authHeader": null,
  "sendActor": true,
  "timeoutMs": 10000,
  "status": "disabled",
  "operations": [
    {
      "id": "get_course",
      "name": "Thông tin học phần",
      "description": "…",
      "method": "GET",
      "path": "/courses/{courseId}",
      "parameters": [
        {
          "name": "courseId",
          "in": "path",
          "type": "string",
          "description": "Mã học phần",
          "required": true
        }
      ]
    }
  ]
}
```

## 6. Giới hạn và vận hành

- Tải dự kiến (lượt/ngày, đỉnh/phút); giới hạn tốc độ của hệ thống nguồn.
- Kích thước phản hồi thường gặp (nền tảng chỉ đọc tối đa 100 KB, đưa cho model tối đa 12.000 ký tự).
- Thời gian phản hồi; timeout đề xuất (1–30 giây).
- Khi hệ thống nguồn lỗi hoặc bảo trì: agent báo lỗi công cụ và trả lời phần còn lại. Ghi liên hệ khi sự cố.

## 7. Agent dùng tích hợp

- Tên agent, chỉ dẫn (vai trò, phạm vi, khi nào gọi thao tác nào, câu từ chối khi ngoài phạm vi).
- Model (`auto` hoặc model cụ thể), số bước tối đa, kho tri thức kèm theo.
- Đơn vị được dùng (thí điểm), có mở cho ứng dụng qua Platform API không.
- Ước tính chi phí: số bước trung bình × chi phí một lượt.

## 8. Kiểm thử và nghiệm thu

| #   | Kịch bản                              | Kết quả mong đợi                        |
| --- | ------------------------------------- | --------------------------------------- |
| 1   | Câu hỏi mẫu 1                         | Agent gọi `<thao tác>`, trả lời đúng    |
| 2   | Tham số sai / không tồn tại           | Agent báo không tìm thấy, không bịa     |
| 3   | Hỏi dữ liệu ngoài quyền của người hỏi | Hệ thống nguồn từ chối / agent từ chối  |
| 4   | Phản hồi chứa dữ liệu nhạy cảm        | DLP che/chặn đúng chính sách            |
| 5   | Hệ thống nguồn tắt                    | Báo lỗi công cụ, không treo quá timeout |

## 9. Duyệt

| Vai trò                   | Họ tên | Ngày | Ý kiến |
| ------------------------- | ------ | ---- | ------ |
| Chủ sở hữu dữ liệu        |        |      |        |
| Phòng CNTT                |        |      |        |
| Pháp chế / bảo vệ dữ liệu |        |      |        |
| Chủ dự án                 |        |      |        |
