#!/usr/bin/env bash
# BigQuery dataset for long-term cost analysis (M8, spec 8.13 – optional). Run in Cloud Shell
# as a project Owner:
#   bash infra/bigquery.sh --dry-run
#   bash infra/bigquery.sh
#
# Creates dataset uniai_analytics in asia-southeast1 (data stays in Vietnam's region of choice).
# Streaming the ledger into it uses the Firebase extension "Stream Firestore to BigQuery",
# installed once in the Console (steps in docs/deploy/M8-runbook.md, step 5). The ledger holds
# no conversation content, so the export carries costs, models and units only.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
LOCATION="${LOCATION:-asia-southeast1}"
DATASET="uniai_analytics"

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

log "1. API BigQuery"
if gcloud services list --enabled --format='value(config.name)' | grep -qx bigquery.googleapis.com; then
  ok "bigquery.googleapis.com đã bật"
else
  apply gcloud services enable bigquery.googleapis.com
fi

log "2. Dataset ${DATASET} (${LOCATION})"
if bq --project_id="$PROJECT_ID" show --format=none "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1; then
  ok "Đã có ${PROJECT_ID}:${DATASET}"
else
  apply bq --project_id="$PROJECT_ID" --location="$LOCATION" mk --dataset \
    --description="UniAI – sổ chi phí AI (usageTransactions) để phân tích dài hạn" \
    "${PROJECT_ID}:${DATASET}"
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Tiếp theo: cài extension Stream Firestore to BigQuery theo docs/deploy/M8-runbook.md bước 5."
