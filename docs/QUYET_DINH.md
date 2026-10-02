# Quyết định của Chủ dự án (Cổng G1)

Ghi nhận ngày 01/10/2026. Nguồn: tin nhắn của Chủ dự án sau khi duyệt Kế hoạch build v1.

| Mã  | Quyết định                    | Chốt                                                                                                                  |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | Project chính                 | `uniaiplatform1`; Claude Cowork đã thêm Firebase vào project này                                                      |
| D2  | Tên miền email được đăng nhập | `@ftu.edu.vn`                                                                                                         |
| D3  | Hệ thống tài khoản            | Google Workspace → Firebase Auth, nhà cung cấp Google                                                                 |
| D4  | Gọi Gemini và Claude          | Qua **Vertex AI**; đồng thời Admin có thể **nhập API key** của Google/Anthropic trong trang quản trị để gọi trực tiếp |
| D5  | OpenAI                        | Có dùng; API key do **Admin nhập trong trang quản trị**                                                               |
| D6  | Chế độ repo                   | Giữ **public**                                                                                                        |
| –   | Nhánh deploy                  | `main` là nguồn deploy; mọi thay đổi vào `main` qua PR                                                                |
| –   | Merge PR (02/10/2026)         | Claude Code **tự merge** PR của mình khi CI xanh, không cần hỏi; production (tag `v*`) vẫn do Chủ dự án duyệt         |

D7–D10 chưa chốt (cần trước M5–M10, xem Kế hoạch build v1 mục 3).
