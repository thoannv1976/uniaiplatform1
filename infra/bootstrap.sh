#!/usr/bin/env bash
# Bootstrap Google Cloud + Firebase for University AI Platform (milestone M1).
#
# Run ONCE in Cloud Shell of project uniaiplatform1, as a project Owner:
#   bash infra/bootstrap.sh --dry-run        # show what would change, change nothing
#   bash infra/bootstrap.sh                  # apply
#
# Safe to re-run: every step checks whether the resource already exists.
# Creating a Firestore database fixes its location FOREVER, so that step only runs with
# --confirm-firestore-location (after the project owner has agreed).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-uniaiplatform1}"
REGION="${REGION:-asia-southeast1}"
GITHUB_REPO="${GITHUB_REPO:-thoannv1976/uniaiplatform1}"
STAGING_DB="staging"
STAGING_SITE="${PROJECT_ID}-staging"
AR_REPO="uniai"
SECRETS=(openai-api-key gemini-api-key anthropic-api-key)
WIF_POOL="github"
WIF_PROVIDER="github-oidc"

DRY_RUN=false
CONFIRM_FIRESTORE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --confirm-firestore-location) CONFIRM_FIRESTORE=true ;;
    -h | --help)
      sed -n '2,12p' "$0"
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
# Runs a mutating command, or only prints it in dry-run mode.
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

API_SA="uniai-api@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="uniai-worker@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

log "Kiểm tra project ${PROJECT_ID}"
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
ok "Số hiệu project: ${PROJECT_NUMBER}; tài khoản: $(gcloud config get-value account 2>/dev/null)"
$DRY_RUN && echo "   (chế độ DRY-RUN: không thay đổi gì)"

log "1. Bật các API cần thiết"
APIS=(run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
  secretmanager.googleapis.com firestore.googleapis.com iamcredentials.googleapis.com
  sts.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com
  aiplatform.googleapis.com bigquery.googleapis.com firebase.googleapis.com
  firebasehosting.googleapis.com identitytoolkit.googleapis.com firebaserules.googleapis.com
  storage.googleapis.com logging.googleapis.com)
ENABLED="$(gcloud services list --enabled --format='value(config.name)')"
MISSING=()
for api in "${APIS[@]}"; do grep -qx "$api" <<<"$ENABLED" || MISSING+=("$api"); done
if ((${#MISSING[@]})); then apply gcloud services enable "${MISSING[@]}"; else ok "Đã bật đủ ${#APIS[@]} API"; fi

log "2. Firestore: database (default) và ${STAGING_DB} ở ${REGION}"
for db in '(default)' "$STAGING_DB"; do
  if exists gcloud firestore databases describe --database="$db"; then
    loc="$(gcloud firestore databases describe --database="$db" --format='value(locationId)')"
    ok "Database ${db} đã có (vị trí: ${loc})"
    [[ "$loc" == "$REGION" ]] || echo "   ⚠ Vị trí ${loc} khác ${REGION} – báo Chủ dự án, KHÔNG xóa database."
  elif $CONFIRM_FIRESTORE || $DRY_RUN; then
    apply gcloud firestore databases create --database="$db" --location="$REGION" --type=firestore-native
  else
    echo "   ⚠ Chưa có database ${db}. Tạo database cố định VĨNH VIỄN vị trí ${REGION}."
    echo "     Khi Chủ dự án đồng ý, chạy lại với --confirm-firestore-location."
    exit 3
  fi
done

log "3. Artifact Registry ${AR_REPO}"
if exists gcloud artifacts repositories describe "$AR_REPO" --location="$REGION"; then
  ok "Đã có ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
else
  apply gcloud artifacts repositories create "$AR_REPO" --repository-format=docker \
    --location="$REGION" --description="UniAI container images"
fi

log "4. Service account"
for spec in "uniai-api:UniAI API runtime" "uniai-worker:UniAI worker runtime" "github-deployer:GitHub Actions deployer"; do
  name="${spec%%:*}"
  if exists gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com"; then
    ok "Đã có ${name}"
  else
    apply gcloud iam service-accounts create "$name" --display-name="${spec#*:}"
  fi
done

log "5. Quyền cấp project (quyền tối thiểu cho M1–M4)"
POLICY="$(gcloud projects get-iam-policy "$PROJECT_ID" --format=json 2>/dev/null || echo '{}')"
has_binding() { # member role
  python3 -c '
import json, sys
policy = json.loads(sys.argv[1]); member, role = sys.argv[2], sys.argv[3]
sys.exit(0 if any(b.get("role") == role and member in b.get("members", []) and "condition" not in b
                  for b in policy.get("bindings", [])) else 1)' "$POLICY" "$1" "$2"
}
grant_project() { # sa role
  if has_binding "serviceAccount:$1" "$2"; then
    ok "$1 → $2"
  else
    apply gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$1" \
      --role="$2" --condition=None --quiet
  fi
}
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter roles/firebaseauth.admin; do
  grant_project "$API_SA" "$role"
done
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter; do
  grant_project "$WORKER_SA" "$role"
done
for role in roles/run.admin roles/artifactregistry.writer roles/firebasehosting.admin \
  roles/firebaserules.admin roles/datastore.indexAdmin roles/serviceusage.serviceUsageConsumer \
  roles/serviceusage.apiKeysViewer; do
  grant_project "$DEPLOY_SA" "$role"
done

log "6. Deployer được gắn service account chạy cho Cloud Run (chỉ 2 SA này)"
for sa in "$API_SA" "$WORKER_SA"; do
  if gcloud iam service-accounts get-iam-policy "$sa" --format=json 2>/dev/null |
    grep -q "serviceAccount:${DEPLOY_SA}"; then
    ok "github-deployer → actAs ${sa%%@*}"
  else
    apply gcloud iam service-accounts add-iam-policy-binding "$sa" \
      --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser --quiet
  fi
done

log "7. Secret Manager: secret rỗng cho API key do Admin nhập (ADR 0002)"
for secret in "${SECRETS[@]}"; do
  if exists gcloud secrets describe "$secret"; then
    ok "Đã có secret ${secret}"
  else
    apply gcloud secrets create "$secret" --replication-policy=automatic
  fi
  for role in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionAdder; do
    if gcloud secrets get-iam-policy "$secret" --format=json 2>/dev/null | python3 2>/dev/null -c '
import json, sys
p = json.load(sys.stdin); m, r = sys.argv[1], sys.argv[2]
sys.exit(0 if any(b["role"] == r and m in b.get("members", []) for b in p.get("bindings", [])) else 1)' \
      "serviceAccount:${API_SA}" "$role"; then
      ok "uniai-api → ${role##*/} trên ${secret}"
    else
      apply gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:${API_SA}" \
        --role="$role" --quiet
    fi
  done
done

log "8. Workload Identity Federation cho GitHub Actions (chỉ repo ${GITHUB_REPO}, nhánh main và tag v*)"
if exists gcloud iam workload-identity-pools describe "$WIF_POOL" --location=global; then
  ok "Đã có pool ${WIF_POOL}"
else
  apply gcloud iam workload-identity-pools create "$WIF_POOL" --location=global \
    --display-name="GitHub Actions"
fi
WIF_CONDITION="assertion.repository=='${GITHUB_REPO}' && (assertion.ref=='refs/heads/main' || assertion.ref.startsWith('refs/tags/v'))"
if exists gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
  --location=global --workload-identity-pool="$WIF_POOL"; then
  ok "Đã có provider ${WIF_PROVIDER}"
else
  apply gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --location=global --workload-identity-pool="$WIF_POOL" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="$WIF_CONDITION"
fi
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}"
if gcloud iam service-accounts get-iam-policy "$DEPLOY_SA" --format=json 2>/dev/null | grep -qF "$PRINCIPAL"; then
  ok "GitHub repo → github-deployer"
else
  apply gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
    --role=roles/iam.workloadIdentityUser --member="$PRINCIPAL" --quiet
fi

# --- Firebase (REST APIs, authenticated as the Cloud Shell user) ---
TOKEN="$(gcloud auth print-access-token)"
fb_api() { # method url [json-body]
  local args=(-sS -X "$1" "$2" -H "Authorization: Bearer ${TOKEN}"
    -H "x-goog-user-project: ${PROJECT_ID}" -H 'Content-Type: application/json')
  if (($# >= 3)); then args+=(--data "$3"); fi
  curl "${args[@]}"
}
# Prints the API error (if any) and returns non-zero.
fb_check() { # response description
  if grep -q '"error"' <<<"$1"; then
    echo "   ⚠ Lỗi khi $2: $(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["error"].get("message",""))' "$1" 2>/dev/null)"
    return 1
  fi
}

log "9. Firebase Hosting: site staging ${STAGING_SITE}"
SITES="$(fb_api GET "https://firebasehosting.googleapis.com/v1beta1/projects/${PROJECT_ID}/sites")"
fb_check "$SITES" "đọc danh sách site" || true
if grep -q "\"sites/${STAGING_SITE}\"" <<<"$SITES"; then
  ok "Đã có site ${STAGING_SITE}.web.app"
elif $DRY_RUN; then
  apply create-hosting-site "$STAGING_SITE"
else
  CHANGES=$((CHANGES + 1))
  echo "   + tạo site ${STAGING_SITE}"
  RES="$(fb_api POST "https://firebasehosting.googleapis.com/v1beta1/projects/${PROJECT_ID}/sites?siteId=${STAGING_SITE}" '{}')"
  fb_check "$RES" "tạo site ${STAGING_SITE}" || echo "     Tạo thủ công: Firebase console → Hosting → Add another site → ${STAGING_SITE}"
fi

log "10. Firebase Auth: Authorized domains"
CONFIG_URL="https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config"
CURRENT="$(fb_api GET "$CONFIG_URL")"
fb_check "$CURRENT" "đọc cấu hình Firebase Auth" || true
WANTED=("${PROJECT_ID}.web.app" "${PROJECT_ID}.firebaseapp.com" "${STAGING_SITE}.web.app" "${STAGING_SITE}.firebaseapp.com")
NEW_LIST="$(python3 -c '
import json, sys
cur = json.loads(sys.argv[1]).get("authorizedDomains", [])
merged = cur + [d for d in sys.argv[2:] if d not in cur]
print(json.dumps(merged) if merged != cur else "")' "$CURRENT" "${WANTED[@]}")"
if [[ -z "$NEW_LIST" ]]; then
  ok "Đã có đủ ${WANTED[*]}"
elif $DRY_RUN; then
  apply set-authorized-domains "$NEW_LIST"
else
  CHANGES=$((CHANGES + 1))
  echo "   + authorizedDomains = ${NEW_LIST}"
  RES="$(fb_api PATCH "${CONFIG_URL}?updateMask=authorizedDomains" "{\"authorizedDomains\": ${NEW_LIST}}")"
  fb_check "$RES" "cập nhật Authorized domains" ||
    echo "     Thêm thủ công: Firebase console → Authentication → Settings → Authorized domains"
fi

log "11. Cấu hình Firebase cho web (công khai, không phải bí mật)"
APPS="$(fb_api GET "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps")"
APP_NAME="$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]).get("apps",[]); print(a[0]["name"] if a else "")' "$APPS")"
WEB_CONFIG=""
if [[ -n "$APP_NAME" ]]; then
  WEB_CONFIG="$(fb_api GET "https://firebase.googleapis.com/v1beta1/${APP_NAME}/config" | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(json.dumps({k: c[k] for k in ("apiKey", "authDomain", "projectId", "appId", "messagingSenderId", "storageBucket") if k in c}, separators=(",", ":")))')"
  ok "Web app: ${APP_NAME##*/}"
else
  echo "   ⚠ Chưa có Web app. Firebase console → Project settings → Your apps → Add app (Web),"
  echo "     tên "UniAI Web", KHÔNG bật Hosting ở bước này, rồi chạy lại script."
fi

log "Kết quả"
if $DRY_RUN; then
  echo "DRY-RUN: ${CHANGES} thay đổi sẽ được thực hiện. Gửi kết quả này cho Chủ dự án trước khi chạy thật."
else
  echo "Đã áp dụng ${CHANGES} thay đổi."
fi
cat <<EOF

Khai báo tại GitHub → ${GITHUB_REPO} → Settings → Secrets and variables → Actions → tab Variables:

  GCP_PROJECT_ID       = ${PROJECT_ID}
  GCP_REGION           = ${REGION}
  GCP_DEPLOY_SA        = ${DEPLOY_SA}
  GCP_WIF_PROVIDER     = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}
  FIREBASE_WEB_CONFIG  = ${WEB_CONFIG:-<chưa có – xem bước 11>}
EOF
