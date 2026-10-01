# University AI Platform

Nền tảng AI đa mô hình dùng chung cho cán bộ, giảng viên: một giao diện chat, nhiều nhà cung cấp
(OpenAI, Google Gemini, Anthropic Claude), quản lý định mức và chi phí tập trung.

| Tài liệu                                         | Nội dung                                        |
| ------------------------------------------------ | ----------------------------------------------- |
| [Đặc tả](docs/Mo_ta_AI_Platform.docx)            | Chức năng, kiến trúc, dữ liệu, API              |
| [Kế hoạch build v1](docs/Ke_hoach_build_v1.docx) | Milestone, phân vai Claude Code / Claude Cowork |
| [CLAUDE.md](CLAUDE.md)                           | Lệnh và quy tắc cho người phát triển            |
| [docs/deploy](docs/deploy)                       | Runbook triển khai, môi trường                  |

## Chạy trên máy

Yêu cầu: Node.js 22, pnpm 10, Java 21 (cho Firebase Emulator).

```bash
pnpm install
pnpm dev      # emulator + web (http://localhost:5173) + api (:8080) + worker (:8081)
pnpm test     # unit test
```

Không cần tài khoản Google Cloud hay API key để phát triển và chạy test.
