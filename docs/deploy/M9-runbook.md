# Runbook M9 – Tệp đính kèm (Cloud Storage)

Người thực hiện: **Claude Cowork** (Cloud Shell + trình duyệt). Thiết kế: ADR 0008.
Không có bước nào KHÔNG ĐẢO NGƯỢC được (bucket mới, chưa có dữ liệu).

## Điều kiện trước

- PR M9 đã merge, workflow **Deploy** (staging) xanh. Deploy đã đặt `FILES_BUCKET=uniaiplatform1-uploads`,
  bộ nhớ API 1 GiB và TTL `files.expireAt`.

## Bước 1 – Bucket, CORS, vòng đời, quyền (Cloud Shell)

```bash
cd ~/uniaiplatform1 && git checkout main && git pull
bash infra/storage.sh --dry-run
bash infra/storage.sh
gcloud storage buckets describe gs://uniaiplatform1-uploads --format='yaml(cors_config,lifecycle_config,location)'
```

Kiểm tra: location `ASIA-SOUTHEAST1`; CORS chỉ có 4 origin Hosting, method PUT; lifecycle 2 luật (tmp/ 1 ngày,
files/ 180 ngày). IAM: `uniai-api` có `storage.objectAdmin` trên bucket và `serviceAccountTokenCreator` trên chính
nó. Quyền IAM có thể mất 1–2 phút để có hiệu lực.

## Bước 2 – Thử từng loại tệp trên staging (trình duyệt)

Đăng nhập staging, màn hình chat → **📎 Đính kèm**:

1. Một PDF có chữ (vài trang) → chip hiện "… · N trang"; hỏi "Tóm tắt tệp" → câu trả lời dựa trên nội dung.
2. Một .docx, một .xlsx, một .pptx → mỗi tệp sẵn sàng, hỏi một câu về nội dung.
3. Một ảnh PNG/JPEG → AUTO chọn model đọc được ảnh (dòng model dưới câu trả lời), mô tả đúng ảnh.
4. Một PDF scan (không có chữ) → báo "PDF không có lớp chữ…". Một tệp .exe đổi đuôi .pdf → "Nội dung tệp không khớp…".
5. Hỏi tiếp trong cùng hội thoại mà không đính kèm lại → model vẫn trả lời theo tệp.

Nếu bước tải lên báo lỗi mã 403: chờ 2 phút (IAM) rồi thử lại; vẫn lỗi → chạy lại bước 1, gửi log Cloud Run
`uniai-api-staging` (lọc `Files`) vào Issue. Lỗi CORS trong Console trình duyệt → kiểm tra origin trong
`infra/storage-cors.json` khớp địa chỉ đang mở.

## Bước 3 – Kiểm tra dữ liệu

Console → Cloud Storage → `uniaiplatform1-uploads`: có `files/staging/<uid>/…` (văn bản `.txt` hoặc ảnh); `tmp/`
trống hoặc chỉ còn tệp < 1 ngày. Firestore (database `staging`) → `files`: bản ghi `ready`, không có nội dung tệp.
Không mở/tải nội dung tệp của người dùng thật.

## Tiêu chí ĐẠT

- Tệp mẫu từng loại (PDF, DOCX, XLSX, PPTX, ảnh) trích xuất đúng, hỏi đáp được trên staging.
- Tải lên từ trình duyệt hoạt động (signed URL, không lỗi CORS).

## Rollback

Không cần gỡ bucket. Tắt tạm tính năng: không có cờ riêng – nếu cần, đặt `FILE_MAX_MB=1` qua deploy (Chủ dự án
quyết định). Thu hồi quyền: `gcloud storage buckets remove-iam-policy-binding …` (ngược bước 1.4).

## Báo cáo

Bình luận vào Issue "Deploy M9": kết quả bước 1–3 (không đính kèm tệp của người thật).
