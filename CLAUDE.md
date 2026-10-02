# University AI Platform

Nền tảng AI đa mô hình (OpenAI, Gemini, Claude) cho cán bộ, giảng viên – chạy trên Google Cloud + Firebase.

- Đặc tả: `docs/Mo_ta_AI_Platform.docx` (mục 8 = chức năng, mục 9 = dữ liệu, mục 13 = milestone).
- Kế hoạch: `docs/Ke_hoach_build_v1.docx` (mục 4 = quy trình với Claude Cowork, mục 6 = việc từng milestone).
- Quyết định kiến trúc: `docs/adr/`. Hạ tầng hiện hành: `docs/deploy/ENVIRONMENT.md`.
- Quyết định của Chủ dự án: `docs/QUYET_DINH.md` (email `@ftu.edu.vn`, Gemini/Claude qua Vertex AI,
  API key do Admin nhập → Secret Manager theo ADR 0002).
- GCP project `uniaiplatform1`, vùng `asia-southeast1`. Claude Code không có quyền vào GCP;
  deploy chạy qua GitHub Actions (`.github/workflows/deploy.yml`: `main` → staging, tag `v*` → production),
  thao tác hạ tầng do Claude Cowork làm theo runbook `docs/deploy/Mx-runbook.md` và `infra/*.sh`.
  Vận hành: `docs/deploy/RUNBOOK-VAN-HANH.md`; go-live: `docs/deploy/GO-LIVE-CHECKLIST.md`.
- Image Cloud Run: `Dockerfile` ở gốc repo, `--build-arg APP=api|worker`.

## Cấu trúc

- `apps/web` – React + Vite SPA → Firebase Hosting
- `apps/api` – NestJS → Cloud Run `uniai-api` (cổng 8080)
- `apps/worker` – NestJS → Cloud Run `uniai-worker` (local: cổng 8081); job `/jobs/*` do Cloud Scheduler gọi (`infra/scheduler.sh`)
- `packages/shared` – schema Zod, tiền tệ micro-USD, vai trò (dùng chung web + server)
- `packages/firestore` – firebase-admin, tên collection, seed, `UserStore`, `DepartmentStore`, `AuditStore`,
  `RegistryStore` (providers/models/prices) + danh mục model mẫu, `ConversationStore`, `UsageStore` (sổ cái),
  `QuotaService` (định mức, ADR 0006), `FileStore` + `GcsBlobStore` (tệp đính kèm, ADR 0008), `UsageAggregator` + `AlertService` + `runUsageJob` (thống kê, ADR 0007), `SettingsStore`
- `packages/documents` – trích nội dung PDF/DOCX/XLSX/PPTX/văn bản, chia đoạn, `ingestDocument` (kho tri thức)
- `packages/ai-providers` – interface `LLMProvider`; `Embedder` (Vertex AI / `MockEmbedder`); adapter OpenAI (Responses API), Gemini và Claude (direct/Vertex AI),
  `MockProvider`; ảnh trong tin nhắn (`images`); `SecretStore` (Secret Manager); contract test chạy bằng HTTP ghi sẵn (`src/testing/`)

## Lệnh

- `pnpm install`
- `pnpm dev` – emulator (Auth 9099, Firestore 8085, Storage 9199, UI 4000) + web 5173 + api 8080 + worker 8081
- `pnpm seed` – dữ liệu mẫu vào emulator (từ chối chạy nếu không có emulator)
- `pnpm lint && pnpm typecheck && pnpm test` – kiểm tra nhanh
- `pnpm test:emulator` – test cần Firebase Emulator (security rules, Firestore)
- `pnpm test:e2e` – Playwright chạy trong Firebase Emulator Auth/Firestore/Storage (đăng nhập → chat → chi phí); trong phiên Claude Code trên web,
  hook đặt sẵn `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
- `pnpm format` – Prettier
- `pnpm ops:grant-role --email … --role … --database … [--allow-outside-domain] [--yes]` – cấp vai trò (Cowork, Cloud Shell)
- `pnpm ops:create-login --email … [--yes]` – tài khoản quản trị dự phòng email + mật khẩu (ADR 0004; mật khẩu gõ ẩn)
- `pnpm ops:smoke-providers --database staging [--include-disabled] [--model id]` – gọi thử mỗi model, in token/chi phí
- Health check là `/health` (KHÔNG dùng đường dẫn kết thúc bằng `z` như `/healthz`: Cloud Run giữ riêng)

Packages build ra `dist/` (ESM); chạy `pnpm build` trước khi typecheck/test một app riêng lẻ.

## Quy tắc bắt buộc

- Web KHÔNG gọi trực tiếp nhà cung cấp AI và KHÔNG truy cập trực tiếp Firestore; mọi thứ qua `apps/api`.
  `firestore.rules` và `storage.rules` luôn là deny-all.
- Chat: `POST /api/ai/chat` trả SSE (schema `packages/shared/src/chat.ts`), web gọi thẳng URL Cloud Run (không qua
  rewrite Hosting – giới hạn 60 giây). Mọi câu trả lời có token phải ghi `usageTransactions`, kể cả khi hủy (ADR 0005).
- Hội thoại chỉ chủ sở hữu đọc được qua API; quản trị viên không xem nội dung hội thoại của người khác.
- Tiền: số nguyên micro-USD, chỉ dùng `packages/shared/src/money.ts`. Không dùng số thực cho tiền.
- Trừ định mức chỉ qua `QuotaService` (`packages/firestore/src/quota.ts`, reserve → commit/release trong transaction,
  ADR 0006); không ghi vào `budgetPeriods` theo từng yêu cầu. Hết định mức → 402, quá nhanh → 429 + Retry-After.
- Tệp đính kèm chỉ qua `/api/files` (signed URL PUT lên `gs://uniaiplatform1-uploads`, ADR 0008); API kiểm tra byte
  đầu và trích văn bản, chỉ giữ văn bản đã trích (hoặc ảnh). Không ghi tên/nội dung tệp vào log hay audit.
- Chat có fallback 1 lần (chỉ trước khi stream chữ), circuit breaker và kill switch `settings/killSwitch` (listener,
  < 5 giây) – ADR 0009. AI cần người dùng đã đồng ý `TERMS_VERSION` (`packages/shared/src/terms.ts`); đổi nội dung
  điều khoản thì tăng phiên bản.
- Kho tri thức (ADR 0011): tài liệu xử lý qua Cloud Tasks → worker `/jobs/kb-ingest` (cục bộ: ngay trong API);
  embedding 768 chiều, index vector `chunks`. Test dùng `MockEmbedder`, không gọi Vertex AI.
- RAG (ADR 0012): chỉ tìm trong kho người dùng được dùng (ACL kiểm tra TRƯỚC truy vấn vector, kho ngoài quyền
  → 403); trích dẫn qua sự kiện SSE `citations` và `messages.citations`; không lưu khối tài liệu vào tin nhắn.
- Không gian làm việc (ADR 0013): prompt riêng chỉ chủ sở hữu thấy; prompt dùng chung do AI Admin/Super Admin
  (hoặc Unit Admin trong phạm vi) chia sẻ; dự án chỉ chủ sở hữu, chỉ dẫn + tệp dự án vào system prompt.
- AUTO đi qua Smart Router (`classifyRequest`, luật trong `settings/router`, ADR 0010); lý do định tuyến luôn
  ghi sổ cái. Không gọi AI để phân loại.
- Dashboard chỉ đọc `usageAggregates` (job worker 5 phút, đúng một lần theo `_checkpoint`, ADR 0007); không quét
  sổ cái khi mở dashboard. VND chỉ để hiển thị (`formatVnd`, tỷ giá `settings/app`).
- Không đọc/ghi API key ngoài module providers; không log key hay dữ liệu DLP. Key chỉ nằm trong Secret Manager
  (`<provider>-api-key[-staging]`, chọn theo database), Firestore chỉ giữ `last4` (ADR 0002).
- Giá model là số nguyên micro-USD/1M token, chỉ thêm bản ghi giá mới (`models/{id}/prices`), không sửa giá cũ.
- Không commit file key service account; deploy chỉ qua GitHub Actions + Workload Identity Federation.
- `AuthGuard` là guard toàn cục: mọi endpoint mới PHẢI khai báo `@Roles(...)` (hoặc `@Public()` cho health
  check), nếu không sẽ bị chặn. Thêm endpoint vào ma trận vai trò trong `apps/api/src/auth/auth.emulator.test.ts`.
- Vai trò/trạng thái lấy từ `users/{uid}` (Firestore), không tin custom claims (ADR 0003).
- Phạm vi Unit Admin = cây con của `scopeDepartmentId` (lọc bằng `departmentPath array-contains`);
  Unit Admin chỉ quản lý người có vai trò `user`. Nhập CSV là all-or-nothing, báo lỗi theo dòng.
- Test dùng Emulator + `MockProvider`; không gọi mạng ra ngoài trong test.
- `auditLogs` và `usageTransactions` (đã committed) không được sửa/xóa.
- Schema dùng chung đặt trong `packages/shared` (Zod); không định nghĩa trùng ở web/api.
- Thay đổi hạ tầng phải nằm trong script idempotent ở `infra/` hoặc runbook; cập nhật `docs/deploy/ENVIRONMENT.md`.

## Quy ước

- Giao diện, thông báo lỗi, tài liệu: tiếng Việt. Mã nguồn, tên biến, comment: tiếng Anh.
- TypeScript strict, ESM (`.js` trong import tương đối ở server packages).
- Claude Code tự merge PR của mình khi CI xanh (quyết định 02/10/2026); production (tag `v*`) do Chủ dự án duyệt.
- Mỗi milestone một PR theo `.github/pull_request_template.md`; nếu cần thao tác hạ tầng thì kèm
  `docs/deploy/Mx-runbook.md` và Issue "Deploy Mx" (`.github/ISSUE_TEMPLATE/deploy.md`).
