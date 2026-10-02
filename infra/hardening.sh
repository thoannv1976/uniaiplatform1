#!/usr/bin/env bash
# Production hardening before go-live (M10, spec 8.12 and 11). Run in Cloud Shell as a project
# Owner:
#   ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/hardening.sh --dry-run
#   ALERT_EMAIL=<hop-thu>@ftu.edu.vn bash infra/hardening.sh
#
# Idempotent. For both Firestore databases ((default), staging): point-in-time recovery (7 days)
# and a daily backup kept 14 days (RPO ≤ 24 h). A Cloud Logging bucket "uniai-audit"
# (asia-southeast1, 365 days) with a sink for audit lines ("audit": true) – the retention LOCK is
# NOT applied here: it cannot be undone and needs the project owner's separate confirmation
# (docs/deploy/RUNBOOK-VAN-HANH.md). A Cloud Monitoring alert when more than 5 % of uniai-api
# requests fail (5xx) over 5 minutes, e-mailed to ALERT_EMAIL.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"
DATABASES=("(default)" "staging")
LOG_BUCKET="uniai-audit"
SINK="uniai-audit-sink"
POLICY="UniAI – tỷ lệ lỗi API > 5%"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,13p' "$0"
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

log "1. Firestore: PITR và backup hằng ngày (giữ 14 ngày)"
for db in "${DATABASES[@]}"; do
  pitr="$(gcloud firestore databases describe --database="$db" --format='value(pointInTimeRecoveryEnablement)' 2>/dev/null || true)"
  if [ "$pitr" = "POINT_IN_TIME_RECOVERY_ENABLED" ]; then
    ok "PITR đã bật cho ${db}"
  else
    apply gcloud firestore databases update --database="$db" --enable-pitr
  fi
  if gcloud firestore backups schedules list --database="$db" --format='value(dailyRecurrence)' 2>/dev/null | grep -q .; then
    ok "Đã có lịch backup hằng ngày cho ${db}"
  else
    apply gcloud firestore backups schedules create --database="$db" --recurrence=daily --retention=14d
  fi
done

log "2. Log bucket ${LOG_BUCKET} (365 ngày) và sink nhật ký audit"
if gcloud logging buckets describe "$LOG_BUCKET" --location="$REGION" >/dev/null 2>&1; then
  ok "Đã có log bucket ${LOG_BUCKET}"
else
  apply gcloud logging buckets create "$LOG_BUCKET" --location="$REGION" --retention-days=365 \
    --description="Nhật ký audit UniAI (khóa retention sau khi Chủ dự án xác nhận)"
fi
FILTER='resource.type="cloud_run_revision" AND jsonPayload.audit=true'
DEST="logging.googleapis.com/projects/${PROJECT_ID}/locations/${REGION}/buckets/${LOG_BUCKET}"
if gcloud logging sinks describe "$SINK" >/dev/null 2>&1; then
  ok "Đã có sink ${SINK}"
else
  apply gcloud logging sinks create "$SINK" "$DEST" --log-filter="$FILTER" \
    --description="Chép dòng audit của uniai-api vào ${LOG_BUCKET}"
fi

log "3. Kênh email và cảnh báo tỷ lệ lỗi"
channel="$(gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" \
  --format='value(name)' 2>/dev/null | head -n1)"
if [ -n "$channel" ]; then
  ok "Kênh ${channel}"
else
  apply gcloud beta monitoring channels create --display-name="UniAI quản trị (email)" --type=email \
    --channel-labels="email_address=${ALERT_EMAIL}"
  $DRY_RUN || channel="$(gcloud beta monitoring channels list \
    --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" --format='value(name)' | head -n1)"
fi
if gcloud alpha monitoring policies list --filter="displayName=\"${POLICY}\"" --format='value(name)' 2>/dev/null | grep -q .; then
  ok "Đã có chính sách \"${POLICY}\""
else
  policy_file="$(mktemp)"
  cat >"$policy_file" <<JSON
{
  "displayName": "${POLICY}",
  "combiner": "OR",
  "conditions": [{
    "displayName": "5xx / tổng yêu cầu uniai-api > 5% trong 5 phút",
    "conditionPrometheusQueryLanguage": {
      "query": "sum(rate(run_googleapis_com:request_count{monitored_resource=\"cloud_run_revision\",service_name=\"uniai-api\",response_code_class=\"5xx\"}[5m])) / sum(rate(run_googleapis_com:request_count{monitored_resource=\"cloud_run_revision\",service_name=\"uniai-api\"}[5m])) > 0.05",
      "duration": "300s",
      "evaluationInterval": "60s"
    }
  }],
  "documentation": {
    "content": "Xem docs/deploy/RUNBOOK-VAN-HANH.md: kiểm tra log uniai-api, nhà cung cấp AI, cân nhắc kill switch hoặc rollback revision.",
    "mimeType": "text/markdown"
  },
  "notificationChannels": ["${channel:-CHANNEL}"]
}
JSON
  apply gcloud alpha monitoring policies create --policy-from-file="$policy_file"
  rm -f "$policy_file"
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Khóa retention log bucket: KHÔNG ĐẢO NGƯỢC – chỉ làm theo RUNBOOK-VAN-HANH.md sau khi Chủ dự án xác nhận."
