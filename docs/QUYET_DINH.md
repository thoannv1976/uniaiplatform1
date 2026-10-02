# Quyết định của Chủ dự án (Cổng G1)

Ghi nhận ngày 01/10/2026. Nguồn: tin nhắn của Chủ dự án sau khi duyệt Kế hoạch build v1.

| Mã  | Quyết định                       | Chốt                                                                                                                  |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | Project chính                    | `uniaiplatform1`; Claude Cowork đã thêm Firebase vào project này                                                      |
| D2  | Tên miền email được đăng nhập    | `@ftu.edu.vn`                                                                                                         |
| D3  | Hệ thống tài khoản               | Google Workspace → Firebase Auth, nhà cung cấp Google                                                                 |
| D4  | Gọi Gemini và Claude             | Qua **Vertex AI**; đồng thời Admin có thể **nhập API key** của Google/Anthropic trong trang quản trị để gọi trực tiếp |
| D5  | OpenAI                           | Có dùng; API key do **Admin nhập trong trang quản trị**                                                               |
| D6  | Chế độ repo                      | Giữ **public**                                                                                                        |
| –   | Nhánh deploy                     | `main` là nguồn deploy; mọi thay đổi vào `main` qua PR                                                                |
| D8  | Thời hạn lưu hội thoại (đề xuất) | **180 ngày** đang áp dụng tạm từ M5 (sổ cái chi phí giữ vĩnh viễn) – **chờ Chủ dự án chốt**                           |
| –   | Merge PR (02/10/2026)            | Claude Code **tự merge** PR của mình khi CI xanh, không cần hỏi; production (tag `v*`) vẫn do Chủ dự án duyệt         |

| D7 | Budget alert Cloud Billing (đề xuất) | **30.000.000 ₫/tháng, cảnh báo 50/90/100 %** – `infra/billing-budget.sh` (M8) – **chờ Chủ dự án chốt** |
| D9 | Nhóm pilot (đề xuất) | **50–100 người từ 2–3 khoa/phòng**, bắt đầu sau khi go-live checklist đạt – **chờ Chủ dự án chốt** |
| D10 | Tên miền (đề xuất) | Pilot dùng `*.web.app` và `*.run.app`; tên miền riêng ở Giai đoạn 2 – **chờ Chủ dự án chốt** |

D7, D9, D10 đang dùng giá trị đề xuất của Kế hoạch build v1 (mục 3), cấu hình được; Chủ dự án xác nhận trước go-live.
