# Runbook M12 – Kho tri thức (nạp tài liệu)

Người thực hiện: **Claude Cowork** (Cloud Shell + trình duyệt). Thiết kế: ADR 0011.
Không có bước KHÔNG ĐẢO NGƯỢC.

## Điều kiện trước

- PR M12 đã merge, Deploy (staging) xanh. Workflow đã deploy worker trước API, đặt `WORKER_URL`,
  `KB_TASKS_QUEUE`, `TASKS_SA_EMAIL` cho API và `FILES_BUCKET` cho worker, tạo index vector `chunks`.
- Đã chạy `infra/storage.sh` (M9) và `infra/scheduler.sh` (M7: service account `uniai-scheduler`).
- Vertex AI API đã bật (M4).

## Bước 1 – Hàng đợi và quyền (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/knowledge.sh --dry-run
bash infra/knowledge.sh
gcloud tasks queues list --location=asia-southeast1
```

Firestore console (database `staging`) → Indexes → Vector: index `chunks` (kbId, embedding) phải **Ready** (có thể mất
vài phút sau deploy).

## Bước 2 – Nạp thử trên staging (AI Admin)

1. Trang quản trị → **Kho tri thức** → tạo kho "Quy chế đào tạo", phạm vi **Toàn trường**.
2. Tải lên 1 PDF quy chế có chữ (văn bản công khai của Trường), điền ngày hiệu lực → trạng thái chuyển
   **Chờ xử lý → Đang xử lý → Sẵn sàng**, có số trang và số đoạn.
3. Tải một bản sửa đổi, chọn "Là phiên bản mới của" bản trên → bản mới v2 **Sẵn sàng**, bản cũ "Đã thay bằng phiên
   bản mới".
4. Tải tệp hỏng (đổi đuôi) → **Lỗi** kèm lý do; **Xử lý lại** vẫn lỗi (đúng).
5. Cloud Run → `uniai-worker-staging` → Logs: dòng `"job":"kb-ingest"` `"status":"ready"`.

Lỗi thường gặp: tài liệu **Lỗi** "Không đưa được vào hàng đợi…" → chạy lại bước 1, rồi **Xử lý lại**. Worker log
`PERMISSION_DENIED` Vertex AI → kiểm tra `uniai-worker` có `roles/aiplatform.user`. 403 khi Cloud Tasks gọi worker →
kiểm tra `uniai-scheduler` có `run.invoker` trên worker (chạy lại `infra/scheduler.sh`).

## Bước 3 – Nạp bộ quy chế mẫu

Chủ dự án cung cấp bộ văn bản quy chế (công khai/nội bộ) và phạm vi của từng kho (toàn trường hay một khoa).
Cowork tạo kho tương ứng và nạp, ghi số tài liệu/số đoạn vào Issue. Không tải văn bản mật.

## Tiêu chí ĐẠT

- Bộ quy chế mẫu nạp xong, mọi tài liệu **Sẵn sàng**; theo dõi được trạng thái từng tài liệu; phiên bản mới thay bản
  cũ.

## Rollback

Tắt kho (nút **Tắt kho**) hoặc xóa tài liệu; tạm dừng hàng đợi: `gcloud tasks queues pause uniai-kb-ingest-staging
--location=asia-southeast1`.

## Báo cáo

Bình luận vào Issue "Deploy M12": kết quả bước 1–3 (không đính kèm văn bản).
