# ADR 0014 – DLP & Policy Engine

- Trạng thái: Đã chấp nhận (M15, 02/10/2026)

## Bối cảnh

Đặc tả 8.11 và 13.2 (M15): trước khi gửi tới nhà cung cấp AI, hệ thống phát hiện dữ liệu nhạy cảm (CCCD/CMND,
số tài khoản/thẻ ngân hàng, mật khẩu, API key, dữ liệu sinh viên/nhân sự, tài liệu mật) và áp dụng chính sách
cho phép / cảnh báo / che / chặn theo đơn vị và vai trò. Mỗi bộ phát hiện có ≥ 20 mẫu dương tính và ≥ 20 mẫu âm
tính; tỷ lệ đúng ≥ 95 %.

## Quyết định

1. **Bộ phát hiện chạy trong API, không gọi dịch vụ ngoài** (`packages/shared/src/dlp.ts`): biểu thức chính quy
   kèm kiểm tra ngữ cảnh – CCCD 12 số có mã tỉnh hợp lệ (hoặc có chữ "CCCD/căn cước"), CMND 9 số chỉ khi có chữ
   "CMND/chứng minh"; thẻ 13–19 số qua thuật toán Luhn, số tài khoản 9–19 số cạnh từ khóa ngân hàng; mật khẩu sau
   "mật khẩu/password/mk/pwd" + `:`/`=`/`là` (sau "là" phải có số hoặc ký tự đặc biệt); khóa có tiền tố đã biết
   (`sk-`, `AIza`, `ghp_`, `AKIA`, `xox…`, `ya29.`, khóa PEM) và chuỗi ≥ 32 ký tự entropy cao (trừ trong đường
   dẫn URL); mã sinh viên/cán bộ 8–10 số đi cùng nhãn và trường cá nhân (điểm, ngày sinh…) hoặc bảng ≥ 3 dòng; dấu
   mật viết hoa (`TUYỆT MẬT`, `TỐI MẬT`, dòng `MẬT`), "Độ mật:", "lưu hành nội bộ", "không phổ biến ra ngoài".
   Không dùng Cloud DLP API: dữ liệu không rời API, không phát sinh chi phí, độ trễ < 1 ms. Bộ mẫu
   `packages/shared/src/dlp.test.ts` (252 mẫu) đạt 100 %.
2. **Chính sách** trong `settings/dlp` (`dlpPolicySchema`): hành động mặc định cho từng loại + danh sách ngoại lệ
   (loại, hành động, đơn vị – gồm đơn vị con, vai trò); ngoại lệ đầu tiên khớp thắng. Mặc định: CCCD và số tài
   khoản **che**, dữ liệu sinh viên/nhân sự **cảnh báo**, mật khẩu, API key, tài liệu mật **chặn**. Nhiều loại cùng
   lúc → hành động nghiêm nhất (chặn > cảnh báo > che > cho phép). Cache 30 giây mỗi instance.
3. **Phạm vi quét**: tin nhắn mới, văn bản trích từ tệp đính kèm mới, chỉ dẫn và tệp của dự án. Lịch sử hội thoại
   gửi lại được **che** theo chính sách hiện hành (mọi loại có hành động "che" với người dùng), để giá trị đã che
   không lộ ở lượt sau. Câu hỏi gửi tới bộ embedding của RAG cũng là bản đã che. Văn bản từ kho tri thức (do quản
   trị nạp) không quét.
4. **Trong chat** (`POST /api/ai/chat`), trước khi lưu lượt hỏi, giữ định mức hay gọi AI:
   - chặn → **422** kèm thông báo loại dữ liệu (không lặp lại giá trị);
   - cảnh báo → **428**; web hiện hộp xác nhận "Vẫn gửi / Sửa lại", gửi lại với `dlpAcknowledged: true`;
   - che → giá trị thay bằng `[CCCD_1]`, `[STK_1]`… (cùng giá trị cùng nhãn trong một yêu cầu); API khôi phục giá
     trị gốc khi stream câu trả lời (giữ lại phần `[…` bị cắt giữa hai đoạn) và khi lưu; sự kiện SSE `dlp` báo
     số lượng đã che / loại đã xác nhận – không gửi giá trị.
     Nội dung người dùng gõ vẫn lưu nguyên trong hội thoại của chính họ (chỉ chủ sở hữu đọc được).
5. **Audit `DLP_ACTION`**: hành động, kết quả (`blocked`/`confirm_required`/`sent`), số lượng theo loại – không ghi
   giá trị hay đoạn văn. Đổi chính sách ghi `ADMIN_CHANGE` (`settings:dlp`).
6. **Quản trị**: `GET /api/admin/dlp-rules` (Super Admin, Auditor), `PUT` và `POST …/test` (Super Admin); trang
   **DLP** trong khu quản trị. (Đặc tả ghi `PATCH`; dùng `PUT` thay toàn bộ chính sách như các trang cấu hình khác.)

## Hệ quả

- Bộ phát hiện dựa trên mẫu nên có thể bỏ sót dạng viết lạ; Trường bổ sung mẫu thật (không chứa dữ liệu thật)
  vào `dlp.test.ts` qua Issue, Claude Code chỉnh luật để giữ ≥ 95 %.
- Che làm câu trả lời của AI dùng nhãn thay giá trị; một số yêu cầu (ví dụ kiểm tra tính hợp lệ của số CCCD) sẽ
  không làm được khi bật che – đúng mục đích bảo vệ dữ liệu.
- Ảnh trong tin nhắn không được quét (không OCR) – ghi nhận rủi ro, hướng dẫn người dùng trong điều khoản.
