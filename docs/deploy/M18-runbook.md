# Runbook M18 – Agent AI và điểm tích hợp (khung)

Người thực hiện: **Claude Cowork** (trình duyệt + Cloud Shell). Thiết kế: ADR 0017. Quy trình tích hợp:
`docs/integrations/README.md`.

M18 chỉ dựng **khung**. Không nối LMS/ERP/SIS thật nào: mỗi hệ thống cần khảo sát và đặc tả được duyệt trước
(`docs/integrations/TEMPLATE.md`).

- Hạ tầng mới duy nhất là secret của từng tích hợp (`infra/integration-secret.sh`).
- Runbook này chỉ tạo secret cho một tích hợp **thử** trên staging. Tích hợp thử gọi chính endpoint `/health` của
  API staging, nên không gửi dữ liệu ra hệ thống ngoài.
- Không có bước KHÔNG ĐẢO NGƯỢC.

> Token tích hợp thật là bí mật: chỉ nhập vào ô **Token mới** (chỉ ghi) trên trang quản trị, **không** dán vào Issue,
> chat hay ảnh chụp màn hình. Ở runbook này dùng token giả `thu-nghiem-khong-bi-mat`.

## Điều kiện trước

- PR M18 đã merge, Deploy (staging) xanh.
- Tài khoản Super Admin hoặc AI Admin trên staging.
- Có ít nhất một model đang bật.

## Bước 1 – Agent chỉ dùng công cụ sẵn có (staging)

1. Trang quản trị → tab **Agent AI** → **+ Thêm agent**, điền:
   - Tên: "Trợ lý thử".
   - Chỉ dẫn: "Trả lời ngắn gọn bằng tiếng Việt. Khi được hỏi ngày giờ, dùng công cụ."
   - Công cụ: **Ngày giờ hiện tại**. Nếu đã có kho tri thức (M12), chọn thêm **Tra cứu kho tri thức** và nhập mã kho.
   - Model `auto`, 4 bước, không chọn đơn vị (toàn trường).
   - Bấm **Lưu agent**.
2. Trang chủ → **Trợ lý AI** → chọn "Trợ lý thử" → hỏi "Hôm nay là thứ mấy, ngày bao nhiêu?".

   Đạt khi:
   - có dòng "✓ Ngày giờ hiện tại – Đã nhận … ký tự";
   - câu trả lời đúng ngày (giờ Việt Nam);
   - cuối câu trả lời có "2 bước · chi phí $… · … giây".

3. Nếu gắn kho tri thức: hỏi một câu có trong tài liệu. Đạt khi có bước "Tra cứu kho tri thức" và câu trả lời dẫn
   nguồn [n].
4. Sửa agent, chọn một đơn vị không phải của tài khoản thử → **Trợ lý AI** không còn hiện agent đó với cán bộ thường
   (Super Admin/AI Admin vẫn thấy). Sửa lại "toàn trường".

## Bước 2 – Secret cho tích hợp thử (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/integration-secret.sh --id thu-nghiem --env staging --dry-run
bash infra/integration-secret.sh --id thu-nghiem --env staging
bash infra/integration-secret.sh --id thu-nghiem --env staging     # lần 2: 0 thay đổi
gcloud run services describe uniai-api-staging --region=asia-southeast1 --format='value(status.url)'
```

Ghi lại URL staging (`https://uniai-api-staging-….run.app`) cho bước 3.

## Bước 3 – Tích hợp thử gọi `/health` của chính API staging

1. Tab **Agent AI** → **+ Thêm tích hợp**:
   - Mã: `thu-nghiem`.
   - Thay toàn bộ cấu hình JSON bằng nội dung dưới đây (đổi `baseUrl` thành URL ở bước 2, không có `/` cuối).
   - Bấm **Lưu tích hợp**.

   ```json
   {
     "name": "Tích hợp thử (health)",
     "type": "other",
     "description": "Chỉ để kiểm tra khung M18, gọi /health của API staging",
     "baseUrl": "https://uniai-api-staging-XXXX.run.app",
     "authType": "bearer",
     "authHeader": null,
     "sendActor": false,
     "timeoutMs": 5000,
     "status": "active",
     "operations": [
       {
         "id": "health",
         "name": "Trạng thái API",
         "description": "Trả về trạng thái, tên dịch vụ, phiên bản và thời gian của API UniAI",
         "method": "GET",
         "path": "/health",
         "parameters": []
       }
     ]
   }
   ```

2. Thử nhập `"method": "POST"` → bị từ chối ("operations.0.method…"); thử `http://` → "phải dùng https://". Sau
   đó trả lại như trên.
3. Ô **Token mới của thu-nghiem**: nhập `thu-nghiem-khong-bi-mat` → **Lưu token**. Danh sách hiện "token …-mat".
   - Nếu báo "Chưa có secret…": bước 2 chưa chạy đúng database (`--env staging`).
4. **Thử thao tác**: chọn "Tích hợp thử (health) › Trạng thái API", tham số `{}` → **Thử**. Đạt khi thấy
   "Thành công · HTTP 200" và đoạn `{"status":"ok",…`.
5. Sửa "Trợ lý thử": thêm công cụ "Tích hợp thử (health) › Trạng thái API" → hỏi ở **Trợ lý AI**: "API UniAI đang
   chạy phiên bản nào?". Đạt khi có bước "✓ thu-nghiem › health" và câu trả lời nêu phiên bản.

## Bước 4 – Đối soát và nhật ký

1. Firestore (database `staging`) → `usageTransactions`: mỗi bước của agent một bản ghi có `agentId`, `routeReason`
   bắt đầu bằng `Agent "Trợ lý thử" – bước n`.
2. Nhật ký (Auditor):
   - `AGENT_RUN`: steps, tools, cost, stopReason.
   - `INTEGRATION_CALL`: operation, status 200, bytes, durationMs.
   - `ADMIN_CHANGE` `integration_token`.
   - **Không** có token, câu hỏi hay dữ liệu trả về.
3. Secret Manager → `integration-thu-nghiem-token-staging` có 1 phiên bản. Không mở xem giá trị, không cần.

## Bước 5 – Dọn dẹp

- Sửa cấu hình tích hợp `thu-nghiem` → `"status": "disabled"`.
- Bỏ công cụ khỏi agent, hoặc tạm dừng "Trợ lý thử".
- Có thể giữ secret thử trên staging (rỗng nghĩa, không có quyền gì) hoặc xóa:
  `gcloud secrets delete integration-thu-nghiem-token-staging`.

## Bước 6 – Production (sau khi Chủ dự án duyệt tag `v*`)

- Không tạo tích hợp thử trên production.
- Agent chỉ dùng công cụ sẵn có thì tạo được ngay theo yêu cầu đơn vị.
- Tích hợp thật: làm theo `docs/integrations/README.md`. Bắt buộc có đặc tả `docs/integrations/<mã>.md` đã duyệt,
  sau đó `bash infra/integration-secret.sh --id <mã> --env production`.

## Rollback

Không cần deploy, các thao tác dưới đây có hiệu lực ngay:

- tạm dừng agent;
- tạm dừng tích hợp (`"status": "disabled"`);
- kill switch.

## Báo cáo

Bình luận vào Issue "Deploy M18": kết quả bước 1–4 (không dán token), số bước và chi phí mỗi lần chạy thử, mã
audit đã thấy.
