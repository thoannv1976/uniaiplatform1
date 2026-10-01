# Môi trường triển khai – nguồn sự thật

Cập nhật mỗi khi Claude Cowork thay đổi hạ tầng hoặc Claude Code thêm biến/secret.

Cập nhật lần cuối: M0 (01/10/2026) – chưa có tài nguyên GCP nào do dự án tạo.

## Google Cloud

| Mục               | Giá trị                                        | Trạng thái                           |
| ----------------- | ---------------------------------------------- | ------------------------------------ |
| Project           | `uniaiplatform1` (số 278562969448)             | Có, đã gắn thanh toán                |
| Firebase          | Cần thêm vào `uniaiplatform1` (quyết định D1)  | Chưa – đang ở `uniaiplatform1-4ec26` |
| Vùng              | `asia-southeast1`                              | –                                    |
| Firestore         | `(default)`, `staging`                         | Chưa tạo                             |
| Cloud Run         | `uniai-api`, `uniai-worker` (+ `-staging`)     | Chưa (M1)                            |
| Artifact Registry | `uniai`                                        | Chưa (M1)                            |
| Service account   | `uniai-api`, `uniai-worker`, `github-deployer` | Chưa (M1)                            |
| Workload Identity | pool `github`, provider `github-oidc`          | Chưa (M1)                            |
| Secret Manager    | `openai-api-key`                               | Chưa (M4)                            |

## GitHub (`thoannv1976/uniaiplatform1`)

| Mục                 | Giá trị                                                             | Trạng thái                               |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Nhánh mặc định      | `main`                                                              | **Chưa có** – xem `M0-runbook.md` bước 1 |
| Bảo vệ nhánh `main` | Bắt buộc PR + CI xanh                                               | Chưa                                     |
| Environments        | `staging`, `production` (người duyệt: `thoannv1976`)                | Chưa                                     |
| Nhãn                | `deploy`, `milestone`                                               | Chưa                                     |
| Actions Variables   | `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER` | Chưa (M1)                                |

## Cổng local (phát triển)

| Dịch vụ                                  | Cổng                      |
| ---------------------------------------- | ------------------------- |
| Web (Vite)                               | 5173 (preview 4173)       |
| API                                      | 8080                      |
| Worker                                   | 8081                      |
| Emulator Auth / Firestore / Storage / UI | 9099 / 8085 / 9199 / 4000 |
