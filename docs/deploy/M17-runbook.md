# Runbook M17 – Platform API

Người thực hiện: **Claude Cowork** (trình duyệt + Cloud Shell). Thiết kế: ADR 0016; hướng dẫn tích hợp:
`docs/platform/README.md`. **Không có thao tác hạ tầng mới** (collection Firestore tạo tự động, không thêm biến môi
trường), không có bước KHÔNG ĐẢO NGƯỢC.

> API key ứng dụng là bí mật: chỉ dán vào Cloud Shell (biến môi trường của phiên), **không** dán vào Issue, chat,
> ảnh chụp màn hình. Sau khi thử xong trên staging: **Tạm dừng** hoặc **Đổi key** ứng dụng thử.

## Điều kiện trước

- PR M17 đã merge, Deploy (staging) xanh. Tài khoản Super Admin hoặc AI Admin trên staging.

## Bước 1 – Tạo ứng dụng thử (staging)

1. Trang quản trị → tab **Ứng dụng** → **Thêm ứng dụng**: tên "Ứng dụng mẫu (thử)", một đơn vị, ngân sách 1 USD,
   60 yêu cầu/phút, quyền "Gọi AI" + "Xem mức sử dụng", không chọn model Nâng cao → **Tạo ứng dụng và cấp key**.
2. Hộp vàng hiện key `uak_…` **một lần**: bấm **Chép key**. Đóng hộp → bảng chỉ còn `…4 ký tự cuối`.
3. Nếu đơn vị đã có ngân sách tháng nhỏ hơn: tạo với ngân sách lớn hơn phần còn lại → báo "Vượt ngân sách đơn vị…"
   (đúng).

## Bước 2 – Chạy ứng dụng mẫu (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
export UNIAI_API_URL="$(gcloud run services describe uniai-api-staging --region=asia-southeast1 --format='value(status.url)')"
read -rs UNIAI_APP_KEY && export UNIAI_APP_KEY      # dán key, Enter (không hiện ra màn hình)
node examples/platform-client/chat.mjs "Xin chào, hãy giới thiệu ngắn về bạn"
node examples/platform-client/chat.mjs "Viết 3 gợi ý ôn thi" --stream
```

Đạt khi: có câu trả lời, dòng `[model – lý do] chi phí $…, mã giao dịch …` và `Tháng …: đã dùng $… / $1.0000`.

Kiểm tra lỗi:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$UNIAI_API_URL/api/platform/v1/chat" \
  -H 'Authorization: Bearer uak_sai' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"x"}]}'   # 401
curl -s "$UNIAI_API_URL/api/platform/v1/models" -H "Authorization: Bearer $UNIAI_APP_KEY"   # 403: chưa cấp quyền models
```

## Bước 3 – Đối soát chi phí

1. Tab **Ứng dụng**: cột "Đã dùng" bằng tổng chi phí các lần chạy (± vài micro-USD làm tròn hiển thị).
2. Sau 5 phút: tab **Thống kê** chọn đơn vị chủ quản → tổng chi phí có phần của ứng dụng; số người dùng hoạt động
   không tăng vì ứng dụng.
3. Firestore (database `staging`) → `usageTransactions`: bản ghi mới có `appClientId`, `uid = app:<mã>`, `reference`
   `sample:…`. Nhật ký (Auditor): `AI_REQUEST` actor `app:<mã>`; `ADMIN_CHANGE` `app_client_create` không có key.
4. **Đổi key** → chạy lại ứng dụng mẫu với key cũ → `HTTP 401`. **Tạm dừng** → `HTTP 403 … tạm dừng`.

## Bước 4 – Production (sau khi Chủ dự án duyệt tag `v*`)

Chỉ tạo ứng dụng thật khi có yêu cầu bằng văn bản của đơn vị chủ quản (tên, người phụ trách, ngân sách, quyền).
Gửi key cho người phụ trách kỹ thuật qua kênh bảo mật do Phòng CNTT quy định (không qua email/chat thường). Nếu đã
bật tên miền riêng (M16), địa chỉ API là `https://<API_CUSTOM_DOMAIN>`.

## Rollback

Tạm dừng ứng dụng trên tab Ứng dụng (hiệu lực ngay), hoặc bật kill switch. Không cần deploy.

## Báo cáo

Bình luận vào Issue "Deploy M17": kết quả bước 1–3 (không dán key), chi phí ứng dụng mẫu và số liệu đối soát.
