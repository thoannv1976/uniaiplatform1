#!/usr/bin/env bash
# E-mail for in-app cost alerts (M8, spec 8.13). Run in Cloud Shell as a project Owner:
#   ALERT_EMAIL=quantri-ai@ftu.edu.vn bash infra/alerts.sh --dry-run
#   ALERT_EMAIL=quantri-ai@ftu.edu.vn bash infra/alerts.sh
#
# Every alert the platform raises (user quota 80 %, unit budget 80 %, university budget
# 50/70/80/90/100 %, forecast above budget) is also logged as JSON with "alert": true. This
# script creates a log-based metric for those lines and a Cloud Monitoring policy that e-mails
# ALERT_EMAIL when one appears. Idempotent. The e-mail never contains AI content or API keys.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
METRIC="uniai_app_alerts"
POLICY="UniAI – cảnh báo chi phí AI"
CHANNEL_NAME="UniAI quản trị (email)"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $arg" >&2
      exit 2
      ;;
  esac
done
if [ -z "${ALERT_EMAIL:-}" ]; then
  echo "Thiếu ALERT_EMAIL (hộp thư nhận cảnh báo), ví dụ ALERT_EMAIL=quantri-ai@ftu.edu.vn" >&2
  exit 2
fi

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

log "1. Log-based metric ${METRIC}"
FILTER='resource.type="cloud_run_revision" AND jsonPayload.alert=true'
if gcloud logging metrics describe "$METRIC" >/dev/null 2>&1; then
  ok "Đã có ${METRIC}"
else
  apply gcloud logging metrics create "$METRIC" \
    --description="Cảnh báo chi phí AI do ứng dụng ghi (alert=true)" --log-filter="$FILTER"
fi

log "2. Kênh thông báo email"
channel="$(gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" \
  --format='value(name)' 2>/dev/null | head -n1)"
if [ -n "$channel" ]; then
  ok "Kênh ${channel}"
else
  apply gcloud beta monitoring channels create --display-name="$CHANNEL_NAME" --type=email \
    --channel-labels="email_address=${ALERT_EMAIL}"
  $DRY_RUN || channel="$(gcloud beta monitoring channels list \
    --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" --format='value(name)' | head -n1)"
fi

log "3. Chính sách cảnh báo \"${POLICY}\""
if gcloud alpha monitoring policies list --filter="displayName=\"${POLICY}\"" --format='value(name)' 2>/dev/null | grep -q .; then
  ok "Đã có chính sách"
else
  policy_file="$(mktemp)"
  cat >"$policy_file" <<JSON
{
  "displayName": "${POLICY}",
  "combiner": "OR",
  "conditions": [{
    "displayName": "Ứng dụng ghi cảnh báo chi phí",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/${METRIC}\" AND resource.type=\"cloud_run_revision\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0,
      "duration": "0s",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_COUNT" }]
    }
  }],
  "documentation": {
    "content": "Xem chi tiết trong Logs Explorer với bộ lọc jsonPayload.alert=true, hoặc mục Thông báo trên nền tảng. Hướng xử lý: docs/deploy/M8-runbook.md.",
    "mimeType": "text/markdown"
  },
  "notificationChannels": ["${channel:-CHANNEL}"]
}
JSON
  apply gcloud alpha monitoring policies create --policy-from-file="$policy_file"
  rm -f "$policy_file"
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Hộp thư ${ALERT_EMAIL} sẽ nhận email xác minh kênh lần đầu (nếu có) – không cần thao tác thêm."
