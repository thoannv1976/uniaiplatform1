# Runbook M2 – Đăng nhập và phân quyền

Người thực hiện: **Claude Cowork**, trong **Cloud Shell** của project `uniaiplatform1`.
Không tạo thêm tài nguyên GCP. Mọi bước đều **đảo ngược được** (đổi lại vai trò bằng chính script/giao diện).

## Điều kiện trước

- Issue "Deploy M1" đã ĐẠT (staging chạy, đăng nhập Google được).
- PR M2 đã merge vào `main` và workflow **Deploy** (staging) xanh.
- Chủ dự án cho biết **email Super Admin đầu tiên** (một địa chỉ `@ftu.edu.vn`).

## Bước 1 – Chuẩn bị Cloud Shell (một lần)

```bash
cd ~/uniaiplatform1 2>/dev/null || git clone https://github.com/thoannv1976/uniaiplatform1.git ~/uniaiplatform1
cd ~/uniaiplatform1 && git checkout main && git pull
node --version            # cần v22 trở lên; nếu thấp hơn: nvm install 22 && nvm use 22
corepack enable
pnpm install --frozen-lockfile --filter "@uniai/firestore..."
pnpm --filter "@uniai/firestore..." build
```

Nếu các bước sau báo `Could not load the default credentials`: chạy
`gcloud auth application-default login` rồi làm lại.

## Bước 2 – Xem trước, rồi cấp quyền Super Admin trên STAGING

```bash
pnpm ops:grant-role --email <email>@ftu.edu.vn --role super_admin --database staging
```

Kiểm tra dòng "Sẽ cấp vai trò super_admin … project uniaiplatform1, database staging". Sau đó:

```bash
pnpm ops:grant-role --email <email>@ftu.edu.vn --role super_admin --database staging --yes
```

> Production (`--database '(default)'`) chỉ làm khi Chủ dự án yêu cầu lên production.

## Xác minh

1. Chủ dự án (email vừa cấp) mở `https://uniaiplatform1-staging.web.app`, đăng nhập:
   thấy "Vai trò: Quản trị hệ thống · Trạng thái: Đang hoạt động" và liên kết **Quản trị người dùng**.
2. Một tài khoản `@ftu.edu.vn` khác đăng nhập lần đầu: thấy thông báo **chờ quản trị viên duyệt**.
3. Super Admin vào **Quản trị người dùng** → tab "Chờ duyệt" → bấm **Duyệt** cho tài khoản ở bước 2;
   tài khoản đó tải lại trang → "Đang hoạt động".
4. Super Admin **Khóa** tài khoản đó → tài khoản bị khóa tải lại trang → thông báo "đã bị khóa";
   sau đó **Mở khóa** lại.
5. Firestore console → database `staging` → collection `auditLogs` có các bản ghi `USER_PROVISIONED`,
   `USER_LOGIN`, `ADMIN_CHANGE`.

## Sự cố thường gặp

| Hiện tượng                                                  | Xử lý                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED` khi chạy script                         | Tài khoản Cloud Shell cần quyền Owner/Editor; kiểm tra `gcloud config get-value account` |
| Script báo email không thuộc tên miền                       | Chỉ cấp cho `@ftu.edu.vn`                                                                |
| Super Admin vẫn thấy "chờ duyệt"                            | Kiểm tra đã dùng `--database staging` và đúng email; chạy lại script rồi tải lại trang   |
| Trang quản trị báo "Endpoint chưa được cấu hình phân quyền" | Lỗi mã – báo Claude Code                                                                 |

## Rollback

Hạ vai trò: `pnpm ops:grant-role --email <email> --role user --database staging --yes`
(hoặc dùng trang Quản trị người dùng bằng một Super Admin khác). Rollback mã: như runbook M1.

## Báo cáo

Bình luận vào Issue "Deploy M2" theo mẫu ở mục 4.3 của Kế hoạch build v1. **Không dán bí mật.**
