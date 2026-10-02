# Runbook M15 – DLP & Policy Engine

Người thực hiện: **Claude Cowork** (trình duyệt). Thiết kế: ADR 0014. **Không có thao tác hạ tầng** (không bật
Cloud DLP API, không thêm biến môi trường), không có bước KHÔNG ĐẢO NGƯỢC.

> Chỉ dùng **dữ liệu giả** khi thử (các số dưới đây là số mẫu). Không dán CCCD, mật khẩu, key thật vào chat,
> Issue hay ảnh chụp màn hình.

## Điều kiện trước

- PR M15 đã merge, workflow Deploy (staging) xanh. Tài khoản Super Admin và một tài khoản người dùng thường trên
  staging.

## Bước 1 – Trang DLP (Super Admin)

1. Quản trị → tab **DLP**: 6 loại dữ liệu với hành động mặc định (CCCD, số tài khoản: Che; dữ liệu sinh viên:
   Cảnh báo; mật khẩu, API key, tài liệu mật: Chặn).
2. Ô **Thử với một đoạn văn bản**:
   - `CCCD 001203004567, STK 0011004123456 Vietcombank` → Che; "Sau khi che: CCCD [CCCD_1], STK [STK_1] …".
   - `mật khẩu: Abc@12345` → Chặn.
   - `Năm 2026 trường tuyển 4000 sinh viên` → Cho phép, không phát hiện.

## Bước 2 – Trong chat (người dùng thường)

1. `Số CCCD của tôi là 001203004567, hãy nhắc lại` → có trả lời; dưới ô nhập: "Đã che 1 số cccd/cmnd trước khi gửi
   tới AI…"; câu trả lời hiện lại đúng số gốc (với model thật, AI chỉ thấy `[CCCD_1]`).
2. `Đăng nhập giúp tôi, mật khẩu: Abc@12345` → thông báo bị chặn, tin nhắn trả lại ô nhập, không tạo hội thoại,
   không trừ định mức.
3. `MSV 11201234, điểm giữa kỳ 8.5 – viết nhận xét` → hộp xác nhận vàng; **Sửa lại** đóng hộp; gửi lại → **Vẫn gửi**
   → có trả lời.
4. Nhật ký (Auditor): các dòng `DLP_ACTION` chỉ có loại và số lượng – **không** có số CCCD/mật khẩu.

## Bước 3 – Ngoại lệ theo đơn vị (khi Trường yêu cầu)

Ví dụ Phòng Đào tạo cần xử lý điểm: **+ Thêm ngoại lệ** → loại "Dữ liệu sinh viên/nhân sự", hành động "Cho phép",
chọn đơn vị → **Lưu chính sách**. Áp dụng trong vòng 30 giây. Ghi quyết định (ai yêu cầu, lý do) vào Issue.

## Bước 4 – Production

Sau khi Chủ dự án duyệt bản phát hành (tag `v*`), lặp lại bước 1–2 trên production với dữ liệu giả. Chính sách
production thống nhất với Chủ dự án/Phòng CNTT trước khi đổi khỏi mặc định.

## Rollback

Đặt hành động "Cho phép" cho loại gây phiền (ví dụ báo nhầm nhiều) trên trang DLP – áp dụng ngay, không cần deploy;
báo Claude Code mẫu bị báo nhầm (đã thay số giả) để chỉnh luật.

## Báo cáo

Bình luận vào Issue "Deploy M15": kết quả bước 1–2 (đạt/không đạt), các mẫu báo nhầm/bỏ sót (đã thay bằng dữ liệu
giả).
