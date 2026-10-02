#!/usr/bin/env bash
# Cloud Scheduler jobs for the worker (M7, spec 8.7). Run in Cloud Shell as a project Owner:
#   bash infra/scheduler.sh --dry-run     # show what would change
#   bash infra/scheduler.sh               # apply (staging and, once deployed, production)
#
# Idempotent: creates or updates. Jobs call the PRIVATE worker with an OIDC token of the
# service account uniai-scheduler, which may only invoke the worker services.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"
TIME_ZONE="Asia/Ho_Chi_Minh"
SCHEDULER_SA="uniai-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,7p' "$0"
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
exists() { "$@" >/dev/null 2>&1; }

gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
$DRY_RUN && echo "(chế độ DRY-RUN: không thay đổi gì)"

log "1. Service account cho Cloud Scheduler"
if exists gcloud iam service-accounts describe "$SCHEDULER_SA"; then
  ok "Đã có ${SCHEDULER_SA}"
else
  apply gcloud iam service-accounts create uniai-scheduler \
    --display-name="UniAI Cloud Scheduler (gọi worker)"
fi

# name|schedule|path|description
JOBS=(
  "quota-rollover|5 0 1 * *|/jobs/quota-rollover|Mở kỳ định mức tháng mới cho mọi người dùng"
  "reservation-sweeper|*/5 * * * *|/jobs/reservation-sweeper|Hoàn trả định mức giữ tạm quá 10 phút, thu hồi cấp tạm hết hạn"
)

for env in staging production; do
  if [ "$env" = production ]; then service="uniai-worker"; else service="uniai-worker-staging"; fi
  log "2. ${env}: worker ${service}"
  url="$(gcloud run services describe "$service" --region="$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [ -z "$url" ]; then
    echo "   – Chưa có Cloud Run ${service} (chưa deploy ${env}); bỏ qua. Chạy lại script sau khi deploy."
    continue
  fi
  ok "URL ${url}"

  if gcloud run services get-iam-policy "$service" --region="$REGION" --format=json 2>/dev/null |
    grep -q "serviceAccount:${SCHEDULER_SA}"; then
    ok "uniai-scheduler → run.invoker trên ${service}"
  else
    apply gcloud run services add-iam-policy-binding "$service" --region="$REGION" \
      --member="serviceAccount:${SCHEDULER_SA}" --role=roles/run.invoker --quiet
  fi

  for spec in "${JOBS[@]}"; do
    IFS='|' read -r name schedule path description <<<"$spec"
    job="uniai-${name}-${env}"
    args=(--location="$REGION" --schedule="$schedule" --time-zone="$TIME_ZONE"
      --uri="${url}${path}" --http-method=POST
      --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$url"
      --attempt-deadline=300s --description="$description")
    if exists gcloud scheduler jobs describe "$job" --location="$REGION"; then
      current="$(gcloud scheduler jobs describe "$job" --location="$REGION" --format='value(schedule,httpTarget.uri)')"
      if [ "$current" = "$(printf '%s\t%s' "$schedule" "${url}${path}")" ]; then
        ok "Job ${job} (${schedule})"
      else
        apply gcloud scheduler jobs update http "$job" "${args[@]}"
      fi
    else
      apply gcloud scheduler jobs create http "$job" "${args[@]}"
    fi
  done
done

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Kiểm tra: gcloud scheduler jobs list --location=${REGION}"
echo "Chạy thử ngay: gcloud scheduler jobs run uniai-reservation-sweeper-staging --location=${REGION}"
