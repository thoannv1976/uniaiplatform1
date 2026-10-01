# Runbook – Tạo tài khoản quản trị dự phòng (email + mật khẩu)

Người thực hiện: **Claude Cowork** (Cloud Shell, GitHub, Firebase console) cùng **Chủ dự án** (gõ mật khẩu).
Thiết kế: [ADR 0004](../adr/0004-tai-khoan-quan-tri-du-phong.md).

## ⚠ Mật khẩu

- **Chủ dự án tự gõ mật khẩu** vào Cloud Shell khi script hỏi (ký tự không hiển thị). Cowork **không** nhận,
  không gõ, không chép mật khẩu vào chat, Issue, PR hay ảnh chụp.
- Mật khẩu: ≥ 12 ký tự, có ít nhất 3 trong 4 loại (thường, hoa, số, ký tự đặc biệt), không chứa tên email.
  Không dùng lại mật khẩu đã từng gửi qua chat.

## Điều kiện trước

- PR chứa ADR 0004 đã merge vào `main` và workflow Deploy staging xanh.
- Cloud Shell đã chuẩn bị theo `M2-runbook.md` bước 1 (Node 22, `pnpm install`, build `@uniai/firestore`).

## Bước 1 – Firebase console: tắt tự đăng ký

Authentication → **Settings** → **User actions** → bỏ chọn **Enable create (sign-up)** → Save.
(Giữ Email/Password ở trạng thái Enabled trong tab Sign-in method.)

## Bước 2 – Tạo đăng nhập (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
pnpm install --frozen-lockfile --filter "@uniai/firestore..." && pnpm --filter "@uniai/firestore..." build
pnpm ops:create-login --email <EMAIL_DU_PHONG>            # xem trước
pnpm ops:create-login --email <EMAIL_DU_PHONG> --yes      # Chủ dự án gõ mật khẩu 2 lần
```

## Bước 3 – Cấp vai trò Super Admin (staging)

```bash
pnpm ops:grant-role --email <EMAIL_DU_PHONG> --role super_admin --database staging --allow-outside-domain
pnpm ops:grant-role --email <EMAIL_DU_PHONG> --role super_admin --database staging --allow-outside-domain --yes
```

## Bước 4 – Cho phép email này ở API

GitHub → Settings → Secrets and variables → Actions → **Variables** → tạo (hoặc sửa)
`EXTRA_ALLOWED_EMAILS` = `<EMAIL_DU_PHONG>` (nhiều email thì ngăn cách bằng dấu phẩy, không dùng `;`).
Sau đó Actions → **Deploy** → Run workflow → `main`, `staging`.

## Xác minh

1. `https://uniaiplatform1-staging.web.app` → mở **Tài khoản quản trị dự phòng** → đăng nhập bằng email + mật
   khẩu → thấy "Vai trò: Quản trị hệ thống · Trạng thái: Đang hoạt động" và **Trang quản trị**.
2. Nhập sai mật khẩu → "Email hoặc mật khẩu không đúng."
3. Một Gmail khác (không có trong `EXTRA_ALLOWED_EMAILS`) đăng nhập Google → bị từ chối.

## Rollback

- Gỡ email khỏi `EXTRA_ALLOWED_EMAILS` và chạy lại Deploy → API từ chối ngay.
- Hạ vai trò: `pnpm ops:grant-role --email <EMAIL_DU_PHONG> --role user --database staging --allow-outside-domain --yes`.
- Vô hiệu hóa đăng nhập: Firebase console → Authentication → Users → Disable account.
