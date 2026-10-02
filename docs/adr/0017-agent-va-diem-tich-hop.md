# ADR 0017 – Khung Agent AI và điểm tích hợp LMS/ERP/SIS

- Trạng thái: Đã chấp nhận (M18, 02/10/2026)

## Bối cảnh

Đặc tả 13.3 (M18): "Khung AI Agents và điểm tích hợp LMS/ERP/SIS (sau khảo sát)", sản phẩm bàn giao "Đặc tả riêng
từng tích hợp trước khi giao Claude Code". Đặc tả cũng ghi tích hợp chi tiết với LMS/ERP/SIS cụ thể nằm ngoài phạm
vi cho tới khi khảo sát. Tại thời điểm M18 Trường chưa khảo sát hệ thống nào, nên không có API thật để gọi.

Vì vậy M18 xây **khung** dùng chung: agent có công cụ, giao thức gọi công cụ độc lập nhà cung cấp, điểm tích hợp chỉ
đọc cấu hình được, cùng quy trình và mẫu đặc tả (`docs/integrations/`). Mỗi hệ thống thật chỉ được cấu hình sau khi
đặc tả của nó được duyệt. Không đoán API của hệ thống nào.

## Quyết định

1. **Agent** `agents/{id}`: tên, mô tả, chỉ dẫn, model (`auto` qua Smart Router hoặc một model), danh sách công cụ,
   kho tri thức, đơn vị được dùng (`publishedTo`, rỗng = toàn trường; khớp `departmentPath`), `allowApps`, số bước
   tối đa (1–8) và trạng thái.
   - AI Admin và Super Admin quản lý, Auditor xem (`/api/admin/agents`).
   - Cán bộ thấy agent đang dùng của đơn vị mình (`GET /api/agents`) và chạy bằng `POST /api/agents/{id}/run`; phải
     đã đồng ý điều khoản. Agent ngoài phạm vi trả 404.
   - Trang web: **Trợ lý AI** (`/tro-ly`) và tab quản trị **Agent AI**.
2. **Giao thức công cụ** (`packages/shared/src/agents.ts`) dùng văn bản thuần, nên chạy được với mọi adapter
   (OpenAI, Gemini, Claude, Mock) mà không cần function calling riêng của từng hãng.
   - System prompt = chỉ dẫn + mô tả công cụ (`buildToolPrompt`). Mỗi bước model trả **hoặc** đúng một JSON
     `{"tool","arguments"}` (`parseToolCall`) **hoặc** câu trả lời cuối.
   - Kết quả công cụ quay lại ở dạng `<tool_result tool=… status=…>`. Prompt nói rõ đó là dữ liệu, không phải chỉ
     dẫn: chống prompt injection từ dữ liệu hệ thống ngoài. Thẻ lồng trong kết quả bị loại bỏ.
   - Câu trả lời stream ngay khi ký tự đầu không giống JSON.
   - Hết số bước → dừng với `max_steps` và báo cho người dùng.
   - SSE: `meta`, `tool`, `dlp`, `delta`, `done` (`steps`, `cost`, `stopReason`), `error`.
3. **Chi phí**: mỗi bước là một lần gọi AI. Nó giữ trước và quyết toán riêng qua `QuotaService`, sổ cái ghi `agentId`
   và lý do "Agent "…" – bước n". Lần giữ trước đầu tiên xảy ra trước khi mở SSE (hết định mức → 402, quá nhanh → 429).
   Từ bước sau, hết định mức thì báo bằng sự kiện `error`. Mỗi bước có kill switch, circuit breaker và fallback như
   chat (`runAttempt`). Audit `AGENT_RUN` ghi số bước, tên công cụ, chi phí, lý do dừng; không ghi nội dung.
4. **Công cụ có sẵn**:
   - `current_datetime`.
   - `knowledge_search`: chỉ cán bộ dùng được, chỉ trên các kho vừa được gán cho agent vừa nằm trong quyền của người
     chạy. ACL kiểm tra trước khi truy vấn vector (ADR 0012); kho ngoài quyền bị bỏ khỏi danh sách công cụ.
5. **Điểm tích hợp** `integrations/{id}`: tên, loại (LMS/ERP/SIS/khác), `baseUrl`, cách xác thực (`none`, `bearer`,
   header riêng), `sendActor`, timeout và các **thao tác**. Mỗi thao tác là công cụ `<mã tích hợp>.<mã thao tác>` của
   agent.
   - **Chỉ `GET`** (schema chỉ nhận `GET`). Thao tác ghi cần đặc tả riêng và bước xác nhận của con người, chưa làm
     ở M18.
   - Tham số có kiểu (`string`/`number`/`boolean`), nằm trong đường dẫn (mã hóa, cấm `.`/`..`) hoặc query.
   - URL cuối phải cùng origin và nằm dưới đường dẫn gốc.
   - Bắt buộc `https`. `http` chỉ cho `localhost` khi bật Mock (test).
   - Không theo redirect, có timeout, đọc tối đa 100 KB.
6. **Token**: chỉ ghi, nằm trong Secret Manager `integration-<mã>-token[-staging]` (chọn theo database như API key,
   ADR 0002). Firestore chỉ giữ `tokenLast4`. Secret tạo trước bằng `infra/integration-secret.sh`; thiếu secret →
   503 kèm hướng dẫn. Không log token hay dữ liệu trả về. Audit `INTEGRATION_CALL` chỉ ghi thao tác, mã HTTP, số
   byte, thời gian. `sendActor` gửi header `X-UniAI-Actor` (email cán bộ hoặc `app:<mã>`) để hệ thống nguồn tự áp
   quyền và ghi vết; đặc tả tích hợp phải nói rõ hệ thống nguồn có cần và có xử lý header này không.
7. **DLP với dữ liệu trả về**: tin nhắn của người dùng vẫn qua DLP như chat (422/428/che). Kết quả công cụ được quét
   bằng cùng chính sách và đối tượng (vai trò, đơn vị):
   - loại bị **chặn** → model không nhận dữ liệu, chỉ nhận thông báo lỗi; audit `DLP_ACTION`;
   - loại bị **che** → model chỉ thấy `[CCCD_1]`…, câu trả lời cho người dùng được khôi phục;
   - **cảnh báo** → cho qua.
     Màn hình **Thử thao tác** của quản trị viên chỉ hiện 2.000 ký tự đầu đã che.
8. **Platform API** (ADR 0016): quyền mới `agents`; `GET /api/platform/v1/agents` và
   `POST /api/platform/v1/agents/{id}/run`, chỉ cho agent có `allowApps`.
   - Chi phí trừ vào ngân sách ứng dụng; ứng dụng không dùng được `knowledge_search`.
   - Ứng dụng không có `allowAdvanced` mà agent bị định tuyến sang nhóm Nâng cao → 403.
   - OpenAPI cập nhật trong `docs/platform/openapi.json`.
9. **Quy trình cho từng hệ thống** (`docs/integrations/README.md`): khảo sát → đặc tả theo
   `docs/integrations/TEMPLATE.md` (dữ liệu, cơ sở pháp lý, quyền, mạng, token, giới hạn) → Chủ dự án duyệt →
   tạo secret → cấu hình ở trạng thái tạm dừng → thử trên staging → bật. Đặc tả lưu ở
   `docs/integrations/<mã>.md`.

## Hệ quả

- Không có tích hợp thật nào sau M18. Cán bộ dùng được ngay agent chỉ có công cụ sẵn có (kho tri thức, ngày giờ).
- Giao thức JSON bằng văn bản kém chắc chắn hơn function calling gốc của từng hãng: model có thể trả JSON sai (khi
  đó văn bản được coi là câu trả lời) hoặc gọi công cụ không tồn tại (nhận lỗi và thử lại trong giới hạn bước). Bù
  lại, cùng một agent chạy được trên mọi nhà cung cấp và Smart Router. Có thể chuyển sang function calling gốc sau
  mà không đổi cấu hình agent.
- Mỗi lần chạy tốn nhiều lần gọi AI (tối đa `maxSteps`), nên chi phí agent cao hơn chat thường; số bước và chi phí
  hiện ở cuối câu trả lời.
- Hệ thống nằm trong mạng nội bộ của Trường mà Cloud Run không truy cập được cần thêm hạ tầng mạng (VPC connector,
  VPN hoặc cổng API công khai có xác thực). Việc này được quyết trong đặc tả từng tích hợp, không làm sẵn.
- `baseUrl` do AI Admin/Super Admin nhập; chỉ người có vai trò này mới thêm được đích gọi ra ngoài. Đặc tả được
  duyệt là điều kiện để cấu hình.
