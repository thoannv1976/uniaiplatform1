#!/usr/bin/env bash
# Custom domain for the API (M16, D10): global external Application Load Balancer with a
# Google-managed certificate in front of Cloud Run uniai-api[-staging]. Run in Cloud Shell as a
# project Owner:
#   bash infra/domain.sh --api-domain api.ai.example.edu.vn --env production --dry-run
#   bash infra/domain.sh --api-domain api.ai.example.edu.vn --env production
#
# Idempotent: creates what is missing, leaves the rest. Prints the IP address for the DNS
# "A" record; the certificate becomes ACTIVE 15–60 minutes after DNS points to it.
# The web's own domain is added in Firebase Hosting (console), see docs/deploy/M16-runbook.md.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"

DRY_RUN=false
API_DOMAIN=""
ENV_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --api-domain)
      API_DOMAIN="${2:-}"
      shift
      ;;
    --env)
      ENV_NAME="${2:-}"
      shift
      ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Tham số không hợp lệ: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if ! [[ "$API_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "Cần --api-domain hợp lệ, ví dụ api.ai.ftu.edu.vn (chữ thường)." >&2
  exit 2
fi
case "$ENV_NAME" in
  production) SUFFIX="" ;;
  staging) SUFFIX="-staging" ;;
  *)
    echo "Cần --env production hoặc --env staging." >&2
    exit 2
    ;;
esac

SERVICE="uniai-api${SUFFIX}"
IP_NAME="uniai-api-ip${SUFFIX}"
NEG="uniai-api-neg${SUFFIX}"
BACKEND="uniai-api-backend${SUFFIX}"
URL_MAP="uniai-api-lb${SUFFIX}"
REDIRECT_MAP="uniai-api-http-redirect${SUFFIX}"
# Certificate names include the domain: a new domain gets a new certificate (no in-place edit).
CERT="uniai-api-cert${SUFFIX}-$(printf '%s' "$API_DOMAIN" | tr '.' '-' | cut -c1-40)"
HTTPS_PROXY_NAME="uniai-api-https-proxy${SUFFIX}"
HTTP_PROXY_NAME="uniai-api-http-proxy${SUFFIX}"
HTTPS_RULE="uniai-api-https${SUFFIX}"
HTTP_RULE="uniai-api-http${SUFFIX}"

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

log "0. Kiểm tra Cloud Run ${SERVICE} và API Compute Engine"
if ! exists gcloud run services describe "$SERVICE" --region="$REGION"; then
  echo "   Chưa có Cloud Run ${SERVICE} – deploy ${ENV_NAME} trước rồi chạy lại." >&2
  exit 1
fi
ok "Có ${SERVICE}"
if gcloud services list --enabled --format='value(config.name)' | grep -qx compute.googleapis.com; then
  ok "compute.googleapis.com đã bật"
else
  apply gcloud services enable compute.googleapis.com
fi

log "1. Địa chỉ IP tĩnh toàn cầu ${IP_NAME}"
if exists gcloud compute addresses describe "$IP_NAME" --global; then
  ok "Đã có ${IP_NAME}"
else
  apply gcloud compute addresses create "$IP_NAME" --global --ip-version=IPV4
fi

log "2. Serverless NEG ${NEG} → ${SERVICE}"
if exists gcloud compute network-endpoint-groups describe "$NEG" --region="$REGION"; then
  ok "Đã có ${NEG}"
else
  apply gcloud compute network-endpoint-groups create "$NEG" --region="$REGION" \
    --network-endpoint-type=serverless --cloud-run-service="$SERVICE"
fi

log "3. Backend service ${BACKEND}"
if exists gcloud compute backend-services describe "$BACKEND" --global; then
  ok "Đã có ${BACKEND}"
else
  apply gcloud compute backend-services create "$BACKEND" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED
fi
if gcloud compute backend-services describe "$BACKEND" --global \
  --format='value(backends[].group)' 2>/dev/null | grep -q "/networkEndpointGroups/${NEG}"; then
  ok "${NEG} đã gắn vào ${BACKEND}"
else
  apply gcloud compute backend-services add-backend "$BACKEND" --global \
    --network-endpoint-group="$NEG" --network-endpoint-group-region="$REGION"
fi

log "4. URL map ${URL_MAP}"
if exists gcloud compute url-maps describe "$URL_MAP" --global; then
  ok "Đã có ${URL_MAP}"
else
  apply gcloud compute url-maps create "$URL_MAP" --global --default-service="$BACKEND"
fi

log "5. Chứng chỉ do Google quản lý ${CERT} (${API_DOMAIN})"
if exists gcloud compute ssl-certificates describe "$CERT" --global; then
  ok "Đã có ${CERT}"
else
  apply gcloud compute ssl-certificates create "$CERT" --global --domains="$API_DOMAIN"
fi

log "6. HTTPS proxy ${HTTPS_PROXY_NAME} và forwarding rule 443"
if exists gcloud compute target-https-proxies describe "$HTTPS_PROXY_NAME" --global; then
  current="$(gcloud compute target-https-proxies describe "$HTTPS_PROXY_NAME" --global --format='value(sslCertificates)')"
  if [[ "$current" == *"/sslCertificates/${CERT}"* ]]; then
    ok "Đã có ${HTTPS_PROXY_NAME} với ${CERT}"
  else
    apply gcloud compute target-https-proxies update "$HTTPS_PROXY_NAME" --global \
      --ssl-certificates="$CERT"
  fi
else
  apply gcloud compute target-https-proxies create "$HTTPS_PROXY_NAME" --global \
    --url-map="$URL_MAP" --ssl-certificates="$CERT"
fi
if exists gcloud compute forwarding-rules describe "$HTTPS_RULE" --global; then
  ok "Đã có ${HTTPS_RULE}"
else
  apply gcloud compute forwarding-rules create "$HTTPS_RULE" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED --address="$IP_NAME" \
    --target-https-proxy="$HTTPS_PROXY_NAME" --ports=443
fi

log "7. Chuyển HTTP → HTTPS (cổng 80)"
if exists gcloud compute url-maps describe "$REDIRECT_MAP" --global; then
  ok "Đã có ${REDIRECT_MAP}"
else
  redirect_file="$(mktemp)"
  cat >"$redirect_file" <<EOF
name: ${REDIRECT_MAP}
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
EOF
  apply gcloud compute url-maps import "$REDIRECT_MAP" --global --source="$redirect_file"
  rm -f "$redirect_file"
fi
if exists gcloud compute target-http-proxies describe "$HTTP_PROXY_NAME" --global; then
  ok "Đã có ${HTTP_PROXY_NAME}"
else
  apply gcloud compute target-http-proxies create "$HTTP_PROXY_NAME" --global --url-map="$REDIRECT_MAP"
fi
if exists gcloud compute forwarding-rules describe "$HTTP_RULE" --global; then
  ok "Đã có ${HTTP_RULE}"
else
  apply gcloud compute forwarding-rules create "$HTTP_RULE" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED --address="$IP_NAME" \
    --target-http-proxy="$HTTP_PROXY_NAME" --ports=80
fi

log "Xong: ${CHANGES} thay đổi$($DRY_RUN && echo ' (chưa áp dụng)')."
ip="$(gcloud compute addresses describe "$IP_NAME" --global --format='value(address)' 2>/dev/null || echo '<chưa tạo>')"
status="$(gcloud compute ssl-certificates describe "$CERT" --global --format='value(managed.status)' 2>/dev/null || echo '<chưa tạo>')"
cat <<EOF

Bản ghi DNS cần tạo (Phòng CNTT quản lý tên miền):
   ${API_DOMAIN}.   A   ${ip}
Trạng thái chứng chỉ: ${status} (ACTIVE sau khi DNS trỏ đúng, thường 15–60 phút)
Kiểm tra: curl -sS https://${API_DOMAIN}/health
Khi /health trả 200: đặt biến môi trường GitHub API_CUSTOM_DOMAIN=${API_DOMAIN} cho môi trường ${ENV_NAME}
rồi deploy lại (xem docs/deploy/M16-runbook.md).
EOF
