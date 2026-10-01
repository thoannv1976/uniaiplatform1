# University AI Platform

Nền tảng AI đa mô hình (OpenAI, Gemini, Claude) cho cán bộ, giảng viên – chạy trên Google Cloud + Firebase.

- Đặc tả: `docs/Mo_ta_AI_Platform.docx` (mục 8 = chức năng, mục 9 = dữ liệu, mục 13 = milestone).
- Kế hoạch: `docs/Ke_hoach_build_v1.docx` (mục 4 = quy trình với Claude Cowork, mục 6 = việc từng milestone).
- Quyết định kiến trúc: `docs/adr/`. Hạ tầng hiện hành: `docs/deploy/ENVIRONMENT.md`.
- Quyết định của Chủ dự án: `docs/QUYET_DINH.md` (email `@ftu.edu.vn`, Gemini/Claude qua Vertex AI,
  API key do Admin nhập → Secret Manager theo ADR 0002).
- GCP project `uniaiplatform1`, vùng `asia-southeast1`. Claude Code không có quyền vào GCP;
  deploy chạy qua GitHub Actions (`.github/workflows/deploy.yml`: `main` → staging, tag `v*` → production),
  thao tác hạ tầng do Claude Cowork làm theo runbook `docs/deploy/Mx-runbook.md` và `infra/bootstrap.sh`.
- Image Cloud Run: `Dockerfile` ở gốc repo, `--build-arg APP=api|worker`.

## Cấu trúc

- `apps/web` – React + Vite SPA → Firebase Hosting
- `apps/api` – NestJS → Cloud Run `uniai-api` (cổng 8080)
- `apps/worker` – NestJS → Cloud Run `uniai-worker` (local: cổng 8081)
- `packages/shared` – schema Zod, tiền tệ micro-USD, vai trò (dùng chung web + server)
- `packages/firestore` – firebase-admin, tên collection, seed
- `packages/ai-providers` – interface `LLMProvider`, `MockProvider`

## Lệnh

- `pnpm install`
- `pnpm dev` – emulator (Auth 9099, Firestore 8085, Storage 9199, UI 4000) + web 5173 + api 8080 + worker 8081
- `pnpm seed` – dữ liệu mẫu vào emulator (từ chối chạy nếu không có emulator)
- `pnpm lint && pnpm typecheck && pnpm test` – kiểm tra nhanh
- `pnpm test:emulator` – test cần Firebase Emulator (security rules, Firestore)
- `pnpm test:e2e` – Playwright; trong phiên Claude Code trên web, hook đặt sẵn `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
- `pnpm format` – Prettier

Packages build ra `dist/` (ESM); chạy `pnpm build` trước khi typecheck/test một app riêng lẻ.

## Quy tắc bắt buộc

- Web KHÔNG gọi trực tiếp nhà cung cấp AI và KHÔNG truy cập trực tiếp Firestore; mọi thứ qua `apps/api`.
  `firestore.rules` và `storage.rules` luôn là deny-all.
- Tiền: số nguyên micro-USD, chỉ dùng `packages/shared/src/money.ts`. Không dùng số thực cho tiền.
- Trừ định mức chỉ qua QuotaService (Firestore transaction); không ghi vào `budgetPeriods` theo từng yêu cầu.
- Không đọc/ghi API key ngoài module providers; không log key hay dữ liệu DLP.
- Không commit file key service account; deploy chỉ qua GitHub Actions + Workload Identity Federation.
- Mọi endpoint mới phải có Guard vai trò + test được/không được truy cập.
- Test dùng Emulator + `MockProvider`; không gọi mạng ra ngoài trong test.
- `auditLogs` và `usageTransactions` (đã committed) không được sửa/xóa.
- Schema dùng chung đặt trong `packages/shared` (Zod); không định nghĩa trùng ở web/api.
- Thay đổi hạ tầng phải nằm trong script idempotent ở `infra/` hoặc runbook; cập nhật `docs/deploy/ENVIRONMENT.md`.

## Quy ước

- Giao diện, thông báo lỗi, tài liệu: tiếng Việt. Mã nguồn, tên biến, comment: tiếng Anh.
- TypeScript strict, ESM (`.js` trong import tương đối ở server packages).
- Mỗi milestone một PR theo `.github/pull_request_template.md`; nếu cần thao tác hạ tầng thì kèm
  `docs/deploy/Mx-runbook.md` và Issue "Deploy Mx" (`.github/ISSUE_TEMPLATE/deploy.md`).
