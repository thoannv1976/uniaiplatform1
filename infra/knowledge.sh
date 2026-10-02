#!/usr/bin/env bash
# Knowledge Base processing (M12, spec 8.9). Run in Cloud Shell as a project Owner:
#   bash infra/knowledge.sh --dry-run
#   bash infra/knowledge.sh
#
# Idempotent. Cloud Tasks queues uniai-kb-ingest-staging and uniai-kb-ingest (asia-southeast1,
# 2 documents at a time, up to 5 attempts with backoff). The API (uniai-api) may enqueue tasks
# that call the private worker with an OIDC token of uniai-scheduler (already allowed to invoke
# the worker, infra/scheduler.sh). The worker reads source files from the uploads bucket and
# calls Vertex AI embeddings (aiplatform.user from bootstrap). The Firestore vector index on
# chunks.embedding is deployed by the Deploy workflow (firestore.indexes.json).
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"
API_SA="uniai-api@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="uniai-worker@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA="uniai-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="gs://${PROJECT_ID}-uploads"
QUEUES=(uniai-kb-ingest-staging uniai-kb-ingest)

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,11p' "$0"
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
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
TASKS_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"

log "1. API Cloud Tasks"
if gcloud services list --enabled --format='value(config.name)' | grep -qx cloudtasks.googleapis.com; then
  ok "cloudtasks.googleapis.com đã bật"
else
  apply gcloud services enable cloudtasks.googleapis.com
fi

log "2. Hàng đợi"
for q in "${QUEUES[@]}"; do
  if gcloud tasks queues describe "$q" --location="$REGION" >/dev/null 2>&1; then
    ok "Đã có hàng đợi ${q}"
  else
    apply gcloud tasks queues create "$q" --location="$REGION" \
      --max-concurrent-dispatches=2 --max-attempts=5 --min-backoff=30s --max-backoff=600s
  fi
done

log "3. Quyền"
if gcloud projects get-iam-policy "$PROJECT_ID" --format=json |
  grep -A3 '"roles/cloudtasks.enqueuer"' | grep -q "serviceAccount:${API_SA}"; then
  ok "uniai-api → cloudtasks.enqueuer"
else
  apply gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${API_SA}" \
    --role=roles/cloudtasks.enqueuer --condition=None --quiet
fi
policy="$(gcloud iam service-accounts get-iam-policy "$TASKS_SA" --format=json 2>/dev/null || echo '{}')"
if grep -A3 '"roles/iam.serviceAccountUser"' <<<"$policy" | grep -q "serviceAccount:${API_SA}"; then
  ok "uniai-api → serviceAccountUser trên uniai-scheduler (gắn OIDC cho task)"
else
  apply gcloud iam service-accounts add-iam-policy-binding "$TASKS_SA" \
    --member="serviceAccount:${API_SA}" --role=roles/iam.serviceAccountUser --quiet
fi
if grep -A3 '"roles/iam.serviceAccountTokenCreator"' <<<"$policy" | grep -q "serviceAccount:${TASKS_AGENT}"; then
  ok "Cloud Tasks service agent → tạo OIDC token cho uniai-scheduler"
else
  apply gcloud iam service-accounts add-iam-policy-binding "$TASKS_SA" \
    --member="serviceAccount:${TASKS_AGENT}" --role=roles/iam.serviceAccountTokenCreator --quiet
fi
if gcloud storage buckets get-iam-policy "$BUCKET" --format=json 2>/dev/null |
  grep -q "serviceAccount:${WORKER_SA}"; then
  ok "uniai-worker → đọc ${BUCKET}"
else
  apply gcloud storage buckets add-iam-policy-binding "$BUCKET" \
    --member="serviceAccount:${WORKER_SA}" --role=roles/storage.objectViewer
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Kiểm tra: gcloud tasks queues list --location=${REGION}"
