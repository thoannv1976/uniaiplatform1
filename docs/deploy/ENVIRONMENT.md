# Môi trường triển khai – nguồn sự thật

Cập nhật mỗi khi Claude Cowork thay đổi hạ tầng hoặc Claude Code thêm biến/secret.

Cập nhật lần cuối: 02/10/2026 – M7 (Claude Code): Cloud Scheduler `uniai-quota-rollover-*` (00:05 ngày 1),
`uniai-reservation-sweeper-*` (5 phút) qua `infra/scheduler.sh`; collection định mức/ngân sách. Trước đó – M5 (Claude Code): index `conversations`, `usageTransactions` và TTL `expireAt`
(khai trong `firestore.indexes.json`, deploy tự áp dụng). Trước đó – M4 (Claude Code): thêm 3 secret API key riêng cho staging (cần chạy lại bootstrap),
biến `VERTEX_LOCATION`, `ENABLE_MOCK_PROVIDER`; collection `providers`, `models`. Trước đó (01/10): bootstrap đã chạy
(Cowork, Issue #2), deploy staging xanh sau khi đổi `/healthz` → `/health`.
Quyết định của Chủ dự án: [`docs/QUYET_DINH.md`](../QUYET_DINH.md).

## Google Cloud – project `uniaiplatform1` (số 278562969448), vùng `asia-southeast1`

| Tài nguyên                  | Staging                                                                              | Production                                              | Tạo bởi          | Trạng thái                                                |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| Firebase                    | dùng chung project                                                                   | dùng chung                                              | Cowork (console) | ✓ Đã thêm                                                 |
| Firestore                   | database `staging`                                                                   | database `(default)`                                    | bootstrap        | ✓                                                         |
| Cloud Run API (công khai)   | `uniai-api-staging`                                                                  | `uniai-api`                                             | deploy.yml       | ✓ staging                                                 |
| Cloud Run worker (riêng tư) | `uniai-worker-staging`                                                               | `uniai-worker`                                          | deploy.yml       | ✓ staging                                                 |
| Hosting site                | `uniaiplatform1-staging`                                                             | `uniaiplatform1`                                        | bootstrap        | ✓                                                         |
| Artifact Registry           | `asia-southeast1-docker.pkg.dev/uniaiplatform1/uniai`                                | (dùng chung)                                            | bootstrap        | ✓                                                         |
| Service account             | `uniai-api`, `uniai-worker`, `github-deployer`                                       | (dùng chung)                                            | bootstrap        | ✓                                                         |
| Workload Identity           | pool `github`, provider `github-oidc` (repo này, `main` + tag `v*`)                  |                                                         | bootstrap        | ✓                                                         |
| Secret Manager (API key)    | `openai-api-key-staging`, `gemini-api-key-staging`, `anthropic-api-key-staging`      | `openai-api-key`, `gemini-api-key`, `anthropic-api-key` | bootstrap        | production ✓ (rỗng); staging: chờ chạy lại bootstrap (M4) |
| Vertex AI Model Garden      | Claude Haiku 4.5, Sonnet 5.5, Opus 5.5 phải được **Enable**; gọi qua vị trí `global` | (dùng chung)                                            | Cowork (console) | Chờ (runbook M4)                                          |

### Dữ liệu Firestore (M2, xem ADR 0003)

| Collection                               | Nội dung                                                                           | Ghi bởi                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `userDirectory/{email}`                  | Vai trò/trạng thái/đơn vị nhà trường cấp cho một email                             | `pnpm ops:grant-role`, trang quản trị, (M3) nhập CSV |
| `users/{uid}`                            | Hồ sơ tạo khi đăng nhập lần đầu                                                    | API                                                  |
| `auditLogs`                              | Nhật ký chỉ-thêm (`USER_LOGIN`, `USER_PROVISIONED`, `AUTH_DENIED`, `ADMIN_CHANGE`) | API, script ops                                      |
| `departments/{id}`                       | Cây đơn vị (M3)                                                                    | trang quản trị, nhập CSV                             |
| `providers/{id}`                         | Cách gọi, bật/tắt, thứ tự dự phòng, **metadata** key (`last4`) – không có key (M4) | trang quản trị                                       |
| `conversations/{id}`, `…/messages/{mid}` | Hội thoại riêng của từng người; `expireAt` + TTL 180 ngày (D8) (M5)                | API (`/api/ai/chat`, `/api/conversations`)           |
| `usageTransactions/{id}`                 | Sổ cái chi phí, chỉ thêm, không TTL (M5)                                           | API                                                  |
| `models/{id}`, `…/prices/{pid}`          | Model Registry và lịch sử giá micro-USD/1M token, chỉ thêm (M4)                    | trang quản trị (**Nạp danh mục mẫu**)                |

Super Admin: staging = _chưa cấp_; production = _chưa cấp_.

### Quyền IAM (bootstrap)

| Service account   | Quyền                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uniai-api`       | datastore.user, aiplatform.user, logging.logWriter, firebaseauth.admin; secretAccessor + secretVersionAdder **chỉ trên 6 secret API key**                                                              |
| `uniai-worker`    | datastore.user, aiplatform.user, logging.logWriter                                                                                                                                                     |
| `uniai-scheduler` | run.invoker **chỉ trên** `uniai-worker`, `uniai-worker-staging` (tạo bởi `infra/scheduler.sh`, M7)                                                                                                     |
| `github-deployer` | run.admin, artifactregistry.writer, firebasehosting.admin, firebaserules.admin, datastore.indexAdmin, serviceUsageConsumer, apiKeysViewer; serviceAccountUser **chỉ trên** `uniai-api`, `uniai-worker` |

### Biến môi trường Cloud Run (do `deploy.yml` đặt)

| Biến                          | API                                                     | Worker                  |
| ----------------------------- | ------------------------------------------------------- | ----------------------- |
| `APP_VERSION`                 | `<ref>-<sha7>`                                          | `<ref>-<sha7>`          |
| `GCLOUD_PROJECT`              | `uniaiplatform1`                                        | `uniaiplatform1`        |
| `FIRESTORE_DATABASE_ID`       | `staging` / `(default)`                                 | `staging` / `(default)` |
| `ALLOWED_EMAIL_DOMAINS`       | `ftu.edu.vn`                                            | –                       |
| `WEB_ORIGINS`                 | `https://<site>.web.app,https://<site>.firebaseapp.com` | –                       |
| `EXTRA_ALLOWED_EMAILS`        | biến GitHub cùng tên (ADR 0004), mặc định rỗng          | –                       |
| `VERTEX_LOCATION`             | `global` (M4)                                           | –                       |
| `CONVERSATION_RETENTION_DAYS` | không đặt = 180 ngày (D8)                               | –                       |
| `ENABLE_MOCK_PROVIDER`        | `true` (staging) / `false` (production) (M4)            | –                       |

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
