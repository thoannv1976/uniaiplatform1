# ADR 0001 – Kiến trúc nền tảng

- Trạng thái: Đã chấp nhận (Kế hoạch build v1, 01/10/2026)

## Bối cảnh

Đặc tả v1.1 chọn Google Cloud + Firebase; mã do Claude Code viết, triển khai do Claude Cowork làm.
Cần một nền móng mà cả hai tác tử và CI chạy được mà không cần quyền vào GCP.

## Quyết định

1. Monorepo pnpm + Turborepo, TypeScript strict, ESM cho mọi package.
2. Web: React + Vite SPA trên Firebase Hosting. API và worker: NestJS trên Cloud Run.
3. Firestore là CSDL duy nhất; trình duyệt không truy cập Firestore/Storage (rules deny-all).
4. Phát triển và test bằng Firebase Emulator Suite (project `demo-uniai`, không chạm project thật)
   và `MockProvider`.
5. Tiền là số nguyên micro-USD; chi phí token làm tròn lên.
6. NestJS test bằng Vitest + `unplugin-swc` (SWC phát decorator metadata cho DI).
7. TypeScript ghim ở 6.0 vì typescript-eslint chưa hỗ trợ TypeScript 7.

## Hệ quả

- `pnpm dev` khởi động emulator + 3 ứng dụng; seed chỉ chạy khi có emulator.
- Gói dùng chung phải build trước (`turbo` lo phụ thuộc `^build`).
