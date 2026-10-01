# Môi trường triển khai – nguồn sự thật

Cập nhật mỗi khi Claude Cowork thay đổi hạ tầng hoặc Claude Code thêm biến/secret.

Cập nhật lần cuối: 01/10/2026 – bootstrap đã chạy (Cowork, Issue #2): Firestore `(default)` và `staging` ở `asia-southeast1`, 3 SA, WIF, Hosting site staging. Deploy staging chạy tới smoke test (lỗi `/healthz`, đã sửa thành `/health`).
Quyết định của Chủ dự án: [`docs/QUYET_DINH.md`](../QUYET_DINH.md).

## Google Cloud – project `uniaiplatform1` (số 278562969448), vùng `asia-southeast1`

| Tài nguyên                  | Staging                                                                         | Production           | Tạo bởi          | Trạng thái |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------- | ---------------- | ---------- |
| Firebase                    | dùng chung project                                                              | dùng chung           | Cowork (console) | ✓ Đã thêm  |
| Firestore                   | database `staging`                                                              | database `(default)` | bootstrap        | ✓          |
| Cloud Run API (công khai)   | `uniai-api-staging`                                                             | `uniai-api`          | deploy.yml       | ✓ staging  |
| Cloud Run worker (riêng tư) | `uniai-worker-staging`                                                          | `uniai-worker`       | deploy.yml       | ✓ staging  |
| Hosting site                | `uniaiplatform1-staging`                                                        | `uniaiplatform1`     | bootstrap        | ✓          |
| Artifact Registry           | `asia-southeast1-docker.pkg.dev/uniaiplatform1/uniai`                           | (dùng chung)         | bootstrap        | ✓          |
| Service account             | `uniai-api`, `uniai-worker`, `github-deployer`                                  | (dùng chung)         | bootstrap        | ✓          |
| Workload Identity           | pool `github`, provider `github-oidc` (repo này, `main` + tag `v*`)             |                      | bootstrap        | ✓          |
| Secret Manager              | `openai-api-key`, `gemini-api-key`, `anthropic-api-key` (rỗng, Admin nhập ở M4) |                      | bootstrap        | ✓ (rỗng)   |

### Dữ liệu Firestore (M2, xem ADR 0003)

| Collection              | Nội dung                                                                           | Ghi bởi                                              |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `userDirectory/{email}` | Vai trò/trạng thái/đơn vị nhà trường cấp cho một email                             | `pnpm ops:grant-role`, trang quản trị, (M3) nhập CSV |
| `users/{uid}`           | Hồ sơ tạo khi đăng nhập lần đầu                                                    | API                                                  |
| `auditLogs`             | Nhật ký chỉ-thêm (`USER_LOGIN`, `USER_PROVISIONED`, `AUTH_DENIED`, `ADMIN_CHANGE`) | API, script ops                                      |

Super Admin: staging = _chưa cấp_; production = _chưa cấp_.

### Quyền IAM (bootstrap)

| Service account   | Quyền                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uniai-api`       | datastore.user, aiplatform.user, logging.logWriter, firebaseauth.admin; secretAccessor + secretVersionAdder **chỉ trên 3 secret API key**                                                              |
| `uniai-worker`    | datastore.user, aiplatform.user, logging.logWriter                                                                                                                                                     |
| `github-deployer` | run.admin, artifactregistry.writer, firebasehosting.admin, firebaserules.admin, datastore.indexAdmin, serviceUsageConsumer, apiKeysViewer; serviceAccountUser **chỉ trên** `uniai-api`, `uniai-worker` |

### Biến môi trường Cloud Run (do `deploy.yml` đặt)

| Biến                    | API                                                     | Worker                  |
| ----------------------- | ------------------------------------------------------- | ----------------------- |
| `APP_VERSION`           | `<ref>-<sha7>`                                          | `<ref>-<sha7>`          |
| `GCLOUD_PROJECT`        | `uniaiplatform1`                                        | `uniaiplatform1`        |
| `FIRESTORE_DATABASE_ID` | `staging` / `(default)`                                 | `staging` / `(default)` |
| `ALLOWED_EMAIL_DOMAINS` | `ftu.edu.vn`                                            | –                       |
| `WEB_ORIGINS`           | `https://<site>.web.app,https://<site>.firebaseapp.com` | –                       |

## GitHub (`thoannv1976/uniaiplatform1`, public)

| Mục                       | Giá trị                                                                                    | Trạng thái                                     |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Nhánh `main`              | Nguồn deploy                                                                               | ✓ Đã tạo (Claude Code, theo yêu cầu Chủ dự án) |
| Nhánh mặc định            | `main`                                                                                     | ✓                                              |
| Bảo vệ nhánh `main`       | Bắt buộc PR + CI xanh                                                                      | ✓                                              |
| Environments              | `staging`, `production` (người duyệt: `thoannv1976`)                                       | ✓                                              |
| Actions Variables         | `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER`, `FIREBASE_WEB_CONFIG` | ✓ Đã khai báo (Cowork, Issue #2)               |
| Actions Variable tùy chọn | `EXTRA_ALLOWED_EMAILS` (tài khoản quản trị dự phòng, ADR 0004)                             | Chờ (runbook tài khoản dự phòng)               |

## Cổng local (phát triển)

| Dịch vụ                                  | Cổng                      |
| ---------------------------------------- | ------------------------- |
| Web (Vite)                               | 5173 (preview 4173)       |
| API                                      | 8080                      |
| Worker                                   | 8081                      |
| Emulator Auth / Firestore / Storage / UI | 9099 / 8085 / 9199 / 4000 |
