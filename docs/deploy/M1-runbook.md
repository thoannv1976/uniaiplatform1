# Runbook M1 – Đưa ứng dụng lên Google Cloud

Người thực hiện: **Claude Cowork**, trong **Cloud Shell** của project `uniaiplatform1` (tài khoản Owner)
và trên GitHub (tài khoản `thoannv1976`).

Kết quả mong đợi: mỗi lần merge vào `main`, GitHub Actions tự deploy lên **staging**:

- Web: `https://uniaiplatform1-staging.web.app`
- API: `https://uniai-api-staging-….asia-southeast1.run.app`

## Điều kiện trước

- Đã hoàn thành Issue "Deploy M0", đặc biệt **nhánh mặc định là `main`**.
- Firebase đã được thêm vào project `uniaiplatform1` (quyết định D1 – đã xong).
- PR M1 đã được merge vào `main` (workflow Deploy sẽ tự bỏ qua cho đến khi xong bước 4 bên dưới).

## Bước 1 – Kiểm tra Firebase (console)

1. Firebase console → project `uniaiplatform1` → **Authentication → Sign-in method**: bật **Google**.
   Email/Password chỉ giữ nếu cần tài khoản quản trị dự phòng.
2. **Project settings → Your apps**: nếu chưa có Web app, bấm _Add app_ → Web, tên `UniAI Web`,
   **không** tích Firebase Hosting ở bước này.
3. **Firestore**: nếu đã tạo database `(default)`, ghi lại **vị trí** (Location) vào báo cáo.

## Bước 2 – Chạy thử (không thay đổi gì)

```bash
git clone https://github.com/thoannv1976/uniaiplatform1.git && cd uniaiplatform1
bash infra/bootstrap.sh --dry-run
```

Gửi toàn bộ kết quả cho Chủ dự án. **Dừng lại chờ đồng ý.**

## Bước 3 – Chạy thật

```bash
bash infra/bootstrap.sh
```

- Nếu script dừng với thông báo **"Chưa có database …"**: việc tạo Firestore cố định vị trí
  **VĨNH VIỄN** (⚠ KHÔNG ĐẢO NGƯỢC). Chỉ khi Chủ dự án xác nhận vị trí `asia-southeast1`, chạy:
  `bash infra/bootstrap.sh --confirm-firestore-location`
- Nếu `(default)` đã tồn tại ở vị trí khác `asia-southeast1`: **không xóa**, ghi vào báo cáo.
- Script an toàn khi chạy lại; nếu một bước lỗi, sửa nguyên nhân rồi chạy lại toàn bộ.

Script tạo: API cần thiết, Firestore `staging`, Artifact Registry `uniai`, 3 service account
(`uniai-api`, `uniai-worker`, `github-deployer`) với quyền tối thiểu, 3 secret rỗng cho API key do Admin
nhập (ADR 0002), Workload Identity Federation (chỉ repo này, nhánh `main` và tag `v*`), Hosting site
`uniaiplatform1-staging`, Authorized domains cho Firebase Auth.

## Bước 4 – Khai báo biến cho GitHub Actions

GitHub → repo → Settings → Secrets and variables → Actions → **Variables** → _New repository variable_,
dùng đúng 5 giá trị script in ra cuối cùng:

| Tên                   | Ví dụ                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`      | `uniaiplatform1`                                                                            |
| `GCP_REGION`          | `asia-southeast1`                                                                           |
| `GCP_DEPLOY_SA`       | `github-deployer@uniaiplatform1.iam.gserviceaccount.com`                                    |
| `GCP_WIF_PROVIDER`    | `projects/278562969448/locations/global/workloadIdentityPools/github/providers/github-oidc` |
| `FIREBASE_WEB_CONFIG` | `{"apiKey":"…","authDomain":"uniaiplatform1.firebaseapp.com",…}` (một dòng JSON)            |

Đây là cấu hình công khai, **không** phải bí mật, nên đặt ở _Variables_ (không phải _Secrets_).

## Bước 5 – Chạy deploy staging

GitHub → Actions → workflow **Deploy** → _Run workflow_ → nhánh `main`, môi trường `staging`
(hoặc chờ lần merge kế tiếp).

## Xác minh

1. Workflow **Deploy** xanh; phần Summary ghi URL web và API.
2. Mở `https://uniaiplatform1-staging.web.app`:
   - thấy "Máy chủ hoạt động bình thường (uniai-api-staging…)";
   - bấm **Đăng nhập bằng Google** bằng tài khoản `@ftu.edu.vn` → thấy "Xin chào …";
   - thử tài khoản Gmail cá nhân → thấy thông báo chỉ chấp nhận `@ftu.edu.vn`.
3. Cloud Run → `uniai-worker-staging`: **không** mở công khai (truy cập trực tiếp trả 403).

## Sự cố thường gặp

| Hiện tượng                                                          | Nguyên nhân                                       | Xử lý                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Deploy báo `Permission 'iam.serviceAccounts.getAccessToken' denied` | Thiếu liên kết WIF hoặc chạy từ nhánh khác `main` | Chạy lại bootstrap; chỉ deploy từ `main`/tag          |
| `allUsers` bị từ chối khi deploy API                                | Chính sách tổ chức chặn truy cập công khai        | Báo Chủ dự án (cần ngoại lệ chính sách cho Cloud Run) |
| Popup đăng nhập báo `auth/unauthorized-domain`                      | Thiếu Authorized domain                           | Thêm domain web vào Authentication → Settings         |
| Web báo không kết nối được máy chủ (CORS)                           | WEB_ORIGINS không khớp domain web                 | Báo Claude Code (sửa trong `deploy.yml`)              |

## Rollback

- API: `gcloud run services update-traffic uniai-api-staging --region=asia-southeast1 --to-revisions=<REVISION_TRƯỚC>=100`
- Web: Firebase console → Hosting → site `uniaiplatform1-staging` → Release history → Rollback.
- Tài nguyên do bootstrap tạo đều xóa được, **trừ** vị trí Firestore.

## Báo cáo

Bình luận vào Issue "Deploy M1" theo mẫu ở mục 4.3 của Kế hoạch build v1. **Không dán bí mật.**
