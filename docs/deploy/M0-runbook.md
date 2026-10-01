# Runbook M0 – Cấu hình GitHub

Người thực hiện: **Claude Cowork** (trên trình duyệt, đăng nhập GitHub `thoannv1976`).
Không có thao tác Google Cloud trong M0. Mọi bước đều **đảo ngược được**.

## Điều kiện trước

- PR/nhánh M0 đã được Chủ dự án xem.

## Bước 1 – Tạo nhánh `main` và đặt làm mặc định

Repo hiện chỉ có nhánh `claude/youthful-davinci-4nzb0q`.

1. GitHub → repo → **Branches** → _New branch_ → tên `main`, nguồn: commit đầu tiên
   `6f7e876` (chỉ có tài liệu). Cách nhanh trong Cloud Shell:
   ```bash
   git clone https://github.com/thoannv1976/uniaiplatform1.git && cd uniaiplatform1
   git push origin 6f7e876:refs/heads/main
   ```
2. Settings → General → **Default branch** → chọn `main`.
3. Báo Chủ dự án để Claude Code mở PR `claude/youthful-davinci-4nzb0q → main` cho M0.

## Bước 2 – Nhãn

Issues → Labels → tạo `deploy` (màu tùy ý) và `milestone`.

## Bước 3 – Bảo vệ nhánh `main`

Settings → Branches (hoặc Rules → Rulesets) → quy tắc cho `main`:

- Require a pull request before merging (không bắt buộc số người duyệt – Chủ dự án tự merge).
- Require status checks to pass: `Lint, typecheck, test`, `Secret scan`
  (tên check xuất hiện sau lần CI đầu tiên chạy).
- Block force pushes; không cho xóa nhánh.

## Bước 4 – Environments

Settings → Environments:

- `staging`: không cần người duyệt.
- `production`: **Required reviewers** = `thoannv1976`; Deployment branches: chỉ tag `v*` và `main`.

## Lưu ý về repo private (quyết định D6)

Với gói GitHub Free cá nhân, repo **private** KHÔNG dùng được bảo vệ nhánh, và người duyệt bắt buộc cho
Environment chỉ có ở GitHub Enterprise. Khuyến nghị: giữ **public** trong giai đoạn build (repo không
chứa bí mật; CI quét bí mật bằng gitleaks), hoặc nâng gói trước khi chuyển private.

## Xác minh

- Tab Actions: workflow **CI** chạy xanh trên nhánh M0.
- Settings hiển thị đúng nhánh mặc định, quy tắc bảo vệ, 2 environments, 2 nhãn.

## Báo cáo

Bình luận vào Issue "Deploy M0" theo mẫu ở mục 4.3 của Kế hoạch build v1.

## Rollback

Xóa quy tắc/environment/nhãn vừa tạo; đặt lại nhánh mặc định.
