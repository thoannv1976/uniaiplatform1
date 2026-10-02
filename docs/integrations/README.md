# Tích hợp LMS/ERP/SIS – quy trình

Thiết kế: [ADR 0017](../adr/0017-agent-va-diem-tich-hop.md). Nền tảng có sẵn **khung** để agent đọc dữ liệu từ hệ
thống của Trường. Mỗi hệ thống cụ thể (LMS, ERP, SIS, thư viện…) chỉ được nối sau khi khảo sát xong và đặc tả được
duyệt (đặc tả 13.3). Hiện **chưa có tích hợp nào** được duyệt.

## Phạm vi khung (M18)

- Chỉ **đọc**: mỗi thao tác là một lệnh `GET` tới API của hệ thống nguồn qua `https`. Không có thao tác ghi, sửa hay
  xóa. Thao tác ghi cần đặc tả riêng và bước xác nhận của con người, sẽ làm thành milestone riêng nếu được duyệt.
- Xác thực:
  - không có;
  - `Authorization: Bearer <token>`;
  - một header riêng (ví dụ `X-Api-Key`).
    Token chỉ nằm trong Secret Manager (`integration-<mã>-token[-staging]`).
- Hệ thống nguồn có thể nhận header `X-UniAI-Actor` (email cán bộ đang hỏi, hoặc `app:<mã>` khi ứng dụng gọi qua
  Platform API) để tự áp quyền và ghi vết.
- Giới hạn: tối đa 30 giây mỗi lần gọi; đọc tối đa 100 KB; không theo redirect.
- Dữ liệu trả về đi qua DLP (che hoặc chặn theo chính sách ở tab **DLP**) trước khi đến model AI. Nhật ký chỉ ghi
  thao tác, mã HTTP, số byte, thời gian; không ghi tham số hay dữ liệu.

## Các bước cho một hệ thống

| #   | Việc                                                                                                                                              | Ai làm                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **Khảo sát** hệ thống nguồn: chủ sở hữu dữ liệu, API sẵn có, cách xác thực, mạng, dữ liệu cá nhân, giới hạn tải                                   | Phòng CNTT + đơn vị chủ quản + nhà cung cấp hệ thống |
| 2   | **Viết đặc tả** `docs/integrations/<mã>.md` theo [TEMPLATE.md](TEMPLATE.md)                                                                       | Phòng CNTT (Claude Code hỗ trợ soạn)                 |
| 3   | **Duyệt** đặc tả: Chủ dự án và chủ sở hữu dữ liệu ký; mục "Dữ liệu cá nhân" có ý kiến bộ phận pháp chế/bảo vệ dữ liệu                             | Chủ dự án                                            |
| 4   | **Tài khoản kỹ thuật** chỉ đọc trên hệ thống nguồn, phạm vi tối thiểu; nếu có token thì cấp riêng cho staging và production                       | Quản trị hệ thống nguồn                              |
| 5   | **Secret**: `bash infra/integration-secret.sh --id <mã> --env staging` (rồi `production`)                                                         | Claude Cowork                                        |
| 6   | **Cấu hình** ở Quản trị → **Agent AI** → **Thêm tích hợp**: dán cấu hình theo mục 5 của đặc tả, trạng thái **Tạm dừng**; nhập token vào ô chỉ ghi | AI Admin                                             |
| 7   | **Thử** từng thao tác bằng **Thử thao tác** trên staging (dữ liệu thử/ẩn danh); kiểm tra kết quả đã che theo DLP                                  | AI Admin + chủ sở hữu dữ liệu                        |
| 8   | **Bật** tích hợp, gắn thao tác vào agent, giới hạn agent cho đơn vị thí điểm (`Đơn vị được dùng`)                                                 | AI Admin                                             |
| 9   | **Theo dõi** 2 tuần: chi phí agent (sổ cái `agentId`), audit `INTEGRATION_CALL` (lỗi, thời gian), phản hồi người dùng                             | AI Admin, Auditor                                    |

Nếu đặc tả cần thứ khung chưa có, Claude Code làm theo đặc tả đã duyệt, mỗi tích hợp một PR. Ví dụ: OAuth client
credentials, thao tác ghi, `POST` để tìm kiếm, kết nối mạng nội bộ (VPC connector/VPN), định dạng không phải
JSON/văn bản.

## Tạm dừng, thu hồi

- **Tạm dừng** tích hợp: Sửa cấu hình → `"status": "disabled"`. Có hiệu lực ngay; agent không còn thấy công cụ.
- **Thu hồi** token: nhập token mới ở ô chỉ ghi (bản cũ vẫn nằm trong Secret Manager cho tới khi bị vô hiệu hóa:
  `gcloud secrets versions disable`). Đồng thời thu hồi trên hệ thống nguồn.
- Khẩn cấp: kill switch dừng mọi lời gọi AI, nên agent cũng dừng.
