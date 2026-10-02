# Môi trường triển khai – nguồn sự thật

Cập nhật mỗi khi Claude Cowork thay đổi hạ tầng hoặc Claude Code thêm biến/secret.

Cập nhật lần cuối: 02/10/2026 – M11 (Claude Code): `settings/router` (luật Smart Router, không cần hạ tầng). Trước đó – M10 (Claude Code): `infra/hardening.sh` (PITR, backup hằng ngày 14 ngày, log bucket
`uniai-audit` + sink, cảnh báo lỗi > 5 %), `settings/killSwitch`, runbook vận hành và checklist go-live. Trước đó – M9 (Claude Code): bucket `gs://uniaiplatform1-uploads` (`infra/storage.sh`: CORS,
vòng đời, quyền ký signed URL), biến `FILES_BUCKET`, bộ nhớ API 1 GiB, TTL `files.expireAt`. Trước đó – M8 (Claude Code): job `uniai-usage-aggregate-*` (5 phút, `infra/scheduler.sh`),
index `usageTransactions (status, committedAt)` và `(uid, period, status)`; script tùy chọn `infra/billing-budget.sh`
(D7: 30.000.000 ₫/tháng, 50/90/100 %), `infra/alerts.sh` (email cảnh báo chi phí), `infra/bigquery.sh` (dataset
`uniai_analytics`). Trước đó – M7 (Claude Code): Cloud Scheduler `uniai-quota-rollover-*` (00:05 ngày 1),
`uniai-reservation-sweeper-*` (5 phút) qua `infra/scheduler.sh`; collection định mức/ngân sách. Trước đó – M5 (Claude Code): index `conversations`, `usageTransactions` và TTL `expireAt`
(khai trong `firestore.indexes.json`, deploy tự áp dụng). Trước đó – M4 (Claude Code): thêm 3 secret API key riêng cho staging (cần chạy lại bootstrap),
biến `VERTEX_LOCATION`, `ENABLE_MOCK_PROVIDER`; collection `providers`, `models`. Trước đó (01/10): bootstrap đã chạy
(Cowork, Issue #2), deploy staging xanh sau khi đổi `/healthz` → `/health`.
Quyết định của Chủ dự án: [`docs/QUYET_DINH.md`](../QUYET_DINH.md).

## Google Cloud – project `uniaiplatform1` (số 278562969448), vùng `asia-southeast1`

| Tài nguyên                   | Staging                                                                              | Production                                              | Tạo bởi            | Trạng thái                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------ | --------------------------------------------------------- |
| Firebase                     | dùng chung project                                                                   | dùng chung                                              | Cowork (console)   | ✓ Đã thêm                                                 |
| Firestore                    | database `staging`                                                                   | database `(default)`                                    | bootstrap          | ✓                                                         |
| Cloud Run API (công khai)    | `uniai-api-staging`                                                                  | `uniai-api`                                             | deploy.yml         | ✓ staging                                                 |
| Cloud Run worker (riêng tư)  | `uniai-worker-staging`                                                               | `uniai-worker`                                          | deploy.yml         | ✓ staging                                                 |
| Hosting site                 | `uniaiplatform1-staging`                                                             | `uniaiplatform1`                                        | bootstrap          | ✓                                                         |
| Artifact Registry            | `asia-southeast1-docker.pkg.dev/uniaiplatform1/uniai`                                | (dùng chung)                                            | bootstrap          | ✓                                                         |
| Service account              | `uniai-api`, `uniai-worker`, `github-deployer`                                       | (dùng chung)                                            | bootstrap          | ✓                                                         |
| Workload Identity            | pool `github`, provider `github-oidc` (repo này, `main` + tag `v*`)                  |                                                         | bootstrap          | ✓                                                         |
| Secret Manager (API key)     | `openai-api-key-staging`, `gemini-api-key-staging`, `anthropic-api-key-staging`      | `openai-api-key`, `gemini-api-key`, `anthropic-api-key` | bootstrap          | production ✓ (rỗng); staging: chờ chạy lại bootstrap (M4) |
| Cloud Storage (tệp đính kèm) | `gs://uniaiplatform1-uploads`, thư mục `tmp/staging`, `files/staging`                | cùng bucket, thư mục `…/production`                     | `infra/storage.sh` | Chờ (runbook M9)                                          |
| Vertex AI Model Garden       | Claude Haiku 4.5, Sonnet 5.5, Opus 5.5 phải được **Enable**; gọi qua vị trí `global` | (dùng chung)                                            | Cowork (console)   | Chờ (runbook M4)                                          |

### Dữ liệu Firestore (M2, xem ADR 0003)

| Collection                               | Nội dung                                                                                           | Ghi bởi                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `userDirectory/{email}`                  | Vai trò/trạng thái/đơn vị nhà trường cấp cho một email                                             | `pnpm ops:grant-role`, trang quản trị, (M3) nhập CSV |
| `users/{uid}`                            | Hồ sơ tạo khi đăng nhập lần đầu                                                                    | API                                                  |
| `auditLogs`                              | Nhật ký chỉ-thêm (`USER_LOGIN`, `USER_PROVISIONED`, `AUTH_DENIED`, `ADMIN_CHANGE`)                 | API, script ops                                      |
| `departments/{id}`                       | Cây đơn vị (M3)                                                                                    | trang quản trị, nhập CSV                             |
| `providers/{id}`                         | Cách gọi, bật/tắt, thứ tự dự phòng, **metadata** key (`last4`) – không có key (M4)                 | trang quản trị                                       |
| `conversations/{id}`, `…/messages/{mid}` | Hội thoại riêng của từng người; `expireAt` + TTL 180 ngày (D8) (M5)                                | API (`/api/ai/chat`, `/api/conversations`)           |
| `usageTransactions/{id}`                 | Sổ cái chi phí, chỉ thêm, không TTL (M5)                                                           | API                                                  |
| `models/{id}`, `…/prices/{pid}`          | Model Registry và lịch sử giá micro-USD/1M token, chỉ thêm (M4)                                    | trang quản trị (**Nạp danh mục mẫu**)                |
| `quotaPeriods/{uid}_{YYYYMM}`            | Định mức tháng, đã dùng, đang giữ tạm, đếm tốc độ (M7, ADR 0006)                                   | API (QuotaService), worker                           |
| `budgetPeriods/{dept}_{YYYYMM}`          | Ngân sách đơn vị; `usedAggregate` do job tổng hợp cập nhật (M7/M8)                                 | trang quản trị, worker                               |
| `quotaTiers/{id}`, `quotaAdjustments`    | Nhóm định mức; điều chỉnh có lý do + người duyệt (M7)                                              | trang quản trị, worker (thu hồi cấp tạm)             |
| `usageAggregates/{YYYYMM}`, `…/days/{d}` | Tổng chi phí theo nhà cung cấp/model/nhóm/đơn vị/ngày; `_checkpoint` (M8, ADR 0007)                | worker (`/jobs/usage-aggregate`)                     |
| `notifications`, `alertStates/{key}`     | Thông báo trong ứng dụng; chống gửi trùng mỗi ngưỡng mỗi kỳ (M8)                                   | API, worker                                          |
| `files/{id}`                             | Tệp đính kèm: tên, loại, kích thước, số trang, đường dẫn Storage; TTL 1 ngày (chờ) / 180 ngày (M9) | API (`/api/files`)                                   |
| `settings/router`                        | Luật Smart Router, nhóm mặc định, tỷ lệ mục tiêu (M11, ADR 0010)                                   | AI Admin, Super Admin                                |
| `settings/killSwitch`                    | Kill switch: tắt toàn bộ/nhà cung cấp/nhóm/model, lý do, phanh khẩn cấp (M10, ADR 0009)            | Super Admin, AI Admin; worker (phanh khẩn cấp)       |
| `settings/app`                           | Tỷ giá hiển thị VND/USD (mặc định 26.000) (M8)                                                     | Super Admin (trang Thống kê)                         |

Super Admin: staging = _chưa cấp_; production = _chưa cấp_.

### Quyền IAM (bootstrap)

| Service account   | Quyền                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uniai-api`       | datastore.user, aiplatform.user, logging.logWriter, firebaseauth.admin; secretAccessor + secretVersionAdder **chỉ trên 6 secret API key**; storage.objectAdmin **chỉ trên** bucket uploads + serviceAccountTokenCreator trên chính nó (M9, `infra/storage.sh`) |
| `uniai-worker`    | datastore.user, aiplatform.user, logging.logWriter                                                                                                                                                                                                             |
| `uniai-scheduler` | run.invoker **chỉ trên** `uniai-worker`, `uniai-worker-staging` (tạo bởi `infra/scheduler.sh`, M7)                                                                                                                                                             |
| `github-deployer` | run.admin, artifactregistry.writer, firebasehosting.admin, firebaserules.admin, datastore.indexAdmin, serviceUsageConsumer, apiKeysViewer; serviceAccountUser **chỉ trên** `uniai-api`, `uniai-worker`                                                         |

### Biến môi trường Cloud Run (do `deploy.yml` đặt)

| Biến                            | API                                                     | Worker                  |
| ------------------------------- | ------------------------------------------------------- | ----------------------- |
| `APP_VERSION`                   | `<ref>-<sha7>`                                          | `<ref>-<sha7>`          |
| `GCLOUD_PROJECT`                | `uniaiplatform1`                                        | `uniaiplatform1`        |
| `FIRESTORE_DATABASE_ID`         | `staging` / `(default)`                                 | `staging` / `(default)` |
| `ALLOWED_EMAIL_DOMAINS`         | `ftu.edu.vn`                                            | –                       |
| `WEB_ORIGINS`                   | `https://<site>.web.app,https://<site>.firebaseapp.com` | –                       |
| `EXTRA_ALLOWED_EMAILS`          | biến GitHub cùng tên (ADR 0004), mặc định rỗng          | –                       |
| `VERTEX_LOCATION`               | `global` (M4)                                           | –                       |
| `CONVERSATION_RETENTION_DAYS`   | không đặt = 180 ngày (D8)                               | –                       |
| `ENABLE_MOCK_PROVIDER`          | `true` (staging) / `false` (production) (M4)            | –                       |
| `FILES_BUCKET`                  | `uniaiplatform1-uploads` (M9)                           | –                       |
| `FILE_MAX_MB`, `FILE_MAX_PAGES` | không đặt = 20 MB, 200 trang (M9, cấu hình được)        | –                       |

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
