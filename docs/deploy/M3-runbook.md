# Runbook M3 – Nhập cây đơn vị và danh sách cán bộ (staging)

Người thực hiện: **Claude Cowork**, trên trình duyệt, đăng nhập bằng tài khoản **Super Admin** của staging.
Không có thao tác Google Cloud. Không tạo tài nguyên mới.

## ⚠ Dữ liệu cá nhân

Danh sách cán bộ là dữ liệu cá nhân. **Không** đưa tệp CSV vào repo, Issue, PR, chat hay ảnh chụp.
Báo cáo chỉ ghi **số lượng** (dòng, thêm mới, cập nhật, lỗi) và số dòng lỗi, không ghi email/họ tên.

## Điều kiện trước

- Issue "Deploy M2" đã ĐẠT (có Super Admin trên staging).
- PR M3 đã merge vào `main`, workflow **Deploy** (staging) xanh.
- Chủ dự án cung cấp 2 tệp **CSV UTF-8** (Excel: _File → Save As → CSV UTF-8_):
  - cây đơn vị theo mẫu `https://uniaiplatform1-staging.web.app/templates/don-vi-mau.csv`;
  - danh sách cán bộ theo mẫu `https://uniaiplatform1-staging.web.app/templates/can-bo-mau.csv`
    (có thể bắt đầu với **một khoa**).

## Định dạng tệp

**don-vi.csv**: `ma_don_vi,ten_don_vi,loai,ma_don_vi_cha`

- `ma_don_vi`: chữ/số/`_`/`-`, tối đa 32 ký tự (tự chuyển thành chữ hoa), không trùng.
- `loai`: `truong` (đúng 1 đơn vị gốc, để trống `ma_don_vi_cha`), `khoa`, `phong`, `ban`, `bo_mon`, `khac`.
- Thứ tự dòng không quan trọng; đơn vị cha có thể nằm sau đơn vị con.

**can-bo.csv**: `email,ho_ten,ma_can_bo,ma_don_vi,chuc_vu,vai_tro,nhom_dinh_muc,trang_thai,don_vi_quan_ly`

- Chỉ email `@ftu.edu.vn`; `ma_don_vi` phải có trong cây đơn vị.
- `vai_tro` (mặc định `user`): `user`, `unit_admin` (bắt buộc điền `don_vi_quan_ly`), `ai_admin`, `auditor`,
  `super_admin`.
- `nhom_dinh_muc` (mặc định `standard`): `standard`, `power`, `research`.
- `trang_thai` (mặc định `active`): `active`, `locked`.

Nhập lại cùng tệp là an toàn: dòng không đổi được bỏ qua. Nếu tệp có **bất kỳ** dòng lỗi nào thì
**không ghi gì**. Hệ thống liệt kê lỗi theo số dòng để sửa rồi chọn lại tệp.

## Bước 1 – Nhập cây đơn vị

1. Mở `https://uniaiplatform1-staging.web.app` → **Trang quản trị** → tab **Đơn vị** → **Nhập CSV**.
2. Chọn tệp `don-vi.csv` → đọc phần xem trước (số dòng thêm mới/cập nhật/lỗi).
3. Có lỗi: ghi lại số dòng và nội dung lỗi (không có dữ liệu cá nhân), gửi Chủ dự án sửa tệp. Không có lỗi:
   bấm **Áp dụng**.
4. Kiểm tra cây hiển thị đúng thứ bậc.

## Bước 2 – Nhập danh sách cán bộ

1. Tab **Cán bộ** → **Nhập CSV** → chọn `can-bo.csv` → xem trước → **Áp dụng**.
2. Kiểm tra: số cán bộ hiển thị; lọc theo một khoa; tìm theo tên không dấu (VD: `nguyen van`).

## Bước 3 – Kiểm tra phân quyền Unit Admin (cần Chủ dự án hỗ trợ)

1. Super Admin đặt một tài khoản thử làm **Quản trị đơn vị** của một khoa (tab Cán bộ → Sửa → Vai trò +
   Đơn vị quản lý), hoặc qua CSV.
2. Tài khoản đó đăng nhập: chỉ thấy cán bộ của khoa mình (và bộ môn con), không đổi được vai trò, không
   chuyển cán bộ sang khoa khác.

## Xác minh (tiêu chí ĐẠT)

- Cây đơn vị và danh sách cán bộ của ít nhất một khoa hiển thị đúng trên staging.
- **Xuất CSV** tải về tệp mở được bằng Excel, tiếng Việt hiển thị đúng.
- Firestore (database `staging`) → `auditLogs` có `ADMIN_CHANGE` với `import_departments`, `import_directory`.

## Rollback

Nhập lại tệp CSV trước đó (hệ thống cập nhật về giá trị cũ). Đơn vị không xóa được, chỉ **Ngừng sử dụng**
(cần chuyển hết cán bộ ra trước). Cán bộ không xóa được, chỉ **Khóa**.

## Báo cáo

Bình luận vào Issue "Deploy M3" theo mẫu ở mục 4.3 của Kế hoạch build v1, **chỉ ghi số lượng**.
