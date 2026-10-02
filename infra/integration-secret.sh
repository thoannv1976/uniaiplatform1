#!/usr/bin/env bash
# Secret for the token of one integration point (M18, ADR 0017). Run in Cloud Shell as a
# project Owner, AFTER the integration's specification is approved (docs/integrations):
#   bash infra/integration-secret.sh --id lms --env staging --dry-run
#   bash infra/integration-secret.sh --id lms --env staging
#   bash infra/integration-secret.sh --id lms --env production
#
# Idempotent. Creates an empty secret integration-<id>-token (production) or
# integration-<id>-token-staging and lets uniai-api read it and add versions. The token itself
# is never passed to this script: an administrator types it in "Quản trị → Agent AI" (write-only,
# Firestore keeps only the last 4 characters). Integrations with authType "none" need no secret.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
API_SA="uniai-api@${PROJECT_ID}.iam.gserviceaccount.com"

DRY_RUN=false
ID=""
ENV_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --id)
      ID="${2:-}"
      shift
      ;;
    --env)
      ENV_NAME="${2:-}"
      shift
      ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! "$ID" =~ ^[a-z][a-z0-9-]{1,29}$ ]]; then
  echo "Thiếu hoặc sai --id (chữ thường, số, '-', 2–30 ký tự, giống mã tích hợp trên trang quản trị)." >&2
  exit 2
fi
case "$ENV_NAME" in
  staging) SECRET="integration-${ID}-token-staging" ;;
  production) SECRET="integration-${ID}-token" ;;
  *)
    echo "Thiếu hoặc sai --env (staging | production)." >&2
    exit 2
    ;;
esac

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

log "1. Secret ${SECRET}"
if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  ok "Đã có secret ${SECRET}"
else
  apply gcloud secrets create "$SECRET" --replication-policy=automatic \
    --labels="app=uniai,kind=integration-token,integration=${ID}"
fi

log "2. Quyền của uniai-api trên ${SECRET}"
for role in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionAdder; do
  if gcloud secrets get-iam-policy "$SECRET" --format=json 2>/dev/null | python3 2>/dev/null -c '
import json, sys
p = json.load(sys.stdin); m, r = sys.argv[1], sys.argv[2]
sys.exit(0 if any(b["role"] == r and m in b.get("members", []) for b in p.get("bindings", [])) else 1)' \
    "serviceAccount:${API_SA}" "$role"; then
    ok "uniai-api → ${role##*/}"
  else
    apply gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${API_SA}" \
      --role="$role" --quiet
  fi
done

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Tiếp theo: Super Admin/AI Admin nhập token ở trang Quản trị → Agent AI (không dán token vào chat/Issue)."
