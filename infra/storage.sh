#!/usr/bin/env bash
# Cloud Storage for chat attachments (M9, spec 8.3). Run in Cloud Shell as a project Owner:
#   bash infra/storage.sh --dry-run
#   bash infra/storage.sh
#
# Idempotent. Creates the private bucket gs://<project>-uploads (asia-southeast1) shared by
# staging and production (folders tmp|files/{staging|production}/…), applies
# infra/storage-cors.json (browser PUT to signed URLs from the Hosting sites) and
# infra/storage-lifecycle.json (tmp/ after 1 day, files/ after 180 days = D8), and lets the API
# service account read/write objects and sign upload URLs (IAM Credentials signBlob on itself).
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"
BUCKET="gs://${PROJECT_ID}-uploads"
API_SA="uniai-api@${PROJECT_ID}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $arg" >&2
      exit 2
      ;;
  esac
done

CHANGES=0
log() { printf '\n== %s\n' "$*"; }
ok() { printf '   ✓ %s\n' "$*"; }
apply() {
  CHANGES=$((CHANGES + 1))
  if $DRY_RUN; then
    printf '   [dry-run] %s\n' "$*"
  else
    printf '   + %s\n' "$*"
    "$@"
  fi
}

gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
$DRY_RUN && echo "(chế độ DRY-RUN: không thay đổi gì)"

log "1. API"
enabled="$(gcloud services list --enabled --format='value(config.name)')"
for api in storage.googleapis.com iamcredentials.googleapis.com; do
  if grep -qx "$api" <<<"$enabled"; then ok "$api"; else apply gcloud services enable "$api"; fi
done

log "2. Bucket ${BUCKET} (${REGION}, riêng tư)"
if gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1; then
  ok "Đã có ${BUCKET}"
else
  apply gcloud storage buckets create "$BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention --default-storage-class=STANDARD
fi

log "3. CORS, vòng đời, tắt soft delete (tệp đã xóa không lưu thêm 7 ngày)"
want_cors="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$HERE/storage-cors.json")"
have_cors="$(gcloud storage buckets describe "$BUCKET" --format='json(cors_config)' 2>/dev/null |
  python3 -c 'import json,sys; d=json.load(sys.stdin) or {}; print(json.dumps(d.get("cors_config") or [], sort_keys=True))' 2>/dev/null || echo '[]')"
if [ "$want_cors" = "$have_cors" ]; then
  ok "CORS đúng"
else
  apply gcloud storage buckets update "$BUCKET" --cors-file="$HERE/storage-cors.json"
fi
# Lifecycle and soft delete: re-applying is harmless.
apply gcloud storage buckets update "$BUCKET" --lifecycle-file="$HERE/storage-lifecycle.json" \
  --clear-soft-delete

log "4. Quyền của ${API_SA}"
if gcloud storage buckets get-iam-policy "$BUCKET" --format=json 2>/dev/null |
  grep -q "serviceAccount:${API_SA}"; then
  ok "storage.objectAdmin trên ${BUCKET}"
else
  apply gcloud storage buckets add-iam-policy-binding "$BUCKET" \
    --member="serviceAccount:${API_SA}" --role=roles/storage.objectAdmin
fi
if gcloud iam service-accounts get-iam-policy "$API_SA" --format=json 2>/dev/null |
  grep -q "roles/iam.serviceAccountTokenCreator"; then
  ok "serviceAccountTokenCreator trên chính nó (ký signed URL)"
else
  apply gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
    --member="serviceAccount:${API_SA}" --role=roles/iam.serviceAccountTokenCreator
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Kiểm tra: gcloud storage buckets describe ${BUCKET} --format='yaml(cors_config,lifecycle_config,location)'"
