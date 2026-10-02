#!/usr/bin/env bash
# Cloud Billing budget for the project (M8, spec 8.13; decision D7). Run in Cloud Shell as a
# Billing Account Administrator (or Billing Account Costs Manager):
#   bash infra/billing-budget.sh --dry-run
#   bash infra/billing-budget.sh                         # 30.000.000 VND/month, alerts at 50/90/100 %
#   BUDGET_AMOUNT=1200USD bash infra/billing-budget.sh   # if the billing account is billed in USD
#
# Idempotent: creates the budget "uniai-monthly", or updates its amount. Budget e-mails go to the
# Billing Account admins/users (default recipients of Cloud Billing). This budget covers the
# whole GCP project (Cloud Run, Firestore, Vertex AI…); AI calls made with OpenAI/Anthropic keys
# are billed by those vendors and are tracked by the in-app dashboard instead.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
BUDGET_NAME="uniai-monthly"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-30000000VND}"
THRESHOLDS=(0.5 0.9 1.0)

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

log "1. API Billing Budgets"
if gcloud services list --enabled --format='value(config.name)' | grep -qx billingbudgets.googleapis.com; then
  ok "billingbudgets.googleapis.com đã bật"
else
  apply gcloud services enable billingbudgets.googleapis.com
fi

log "2. Tài khoản thanh toán của ${PROJECT_ID}"
account="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
if [ -z "$account" ]; then
  echo "   ✗ Dự án chưa gắn tài khoản thanh toán." >&2
  exit 1
fi
currency="$(gcloud billing accounts describe "$account" --format='value(currencyCode)' 2>/dev/null || true)"
ok "Billing account ${account} (tiền tệ ${currency:-không rõ})"
if [ -n "$currency" ] && [[ "$BUDGET_AMOUNT" != *"$currency" ]]; then
  echo "   ✗ Tài khoản thanh toán dùng ${currency}; đặt BUDGET_AMOUNT theo ${currency}, ví dụ BUDGET_AMOUNT=1200${currency}." >&2
  exit 1
fi

log "3. Ngân sách ${BUDGET_NAME} = ${BUDGET_AMOUNT}/tháng"
threshold_args=()
for t in "${THRESHOLDS[@]}"; do threshold_args+=(--threshold-rule="percent=${t}"); done
existing="$(gcloud billing budgets list --billing-account="$account" \
  --filter="displayName=${BUDGET_NAME}" --format='value(name)' 2>/dev/null | head -n1)"
if [ -z "$existing" ]; then
  apply gcloud billing budgets create --billing-account="$account" \
    --display-name="$BUDGET_NAME" --budget-amount="$BUDGET_AMOUNT" \
    --filter-projects="projects/${PROJECT_ID}" --calendar-period=month "${threshold_args[@]}"
else
  current="$(gcloud billing budgets describe "$existing" --format='value(amount.specifiedAmount.units,amount.specifiedAmount.currencyCode)' | tr -d '\t')"
  if [ "$current" = "$BUDGET_AMOUNT" ]; then
    ok "Ngân sách đã đúng (${current})"
  else
    apply gcloud billing budgets update "$existing" --budget-amount="$BUDGET_AMOUNT" \
      --clear-threshold-rules "${threshold_args[@]}"
  fi
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
echo "Kiểm tra: Console → Billing → Budgets & alerts → ${BUDGET_NAME}"
