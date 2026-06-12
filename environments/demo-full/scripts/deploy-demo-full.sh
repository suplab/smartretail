#!/usr/bin/env bash
# deploy-demo-full.sh — end-to-end full-stack demo deployment (cdk-demo-full stack)
#
# Full stack vs demo: adds Firehose delivery stream, S3 events + SageMaker buckets,
# ML Trigger Lambda, Batch Post-Processor Lambda, SIS service, Supplier Cognito pool.
#
# Usage:
#   ./environments/demo-full/scripts/deploy-demo-full.sh
#   SMARTRETAIL_ENV=demo-full AWS_PROFILE=smartretail-demo-full ./environments/demo-full/scripts/deploy-demo-full.sh
#
# Optional context:
#   CDK_CONTEXT_alertEmail=you@example.com ./environments/demo-full/scripts/deploy-demo-full.sh
#     — enables CloudWatch alarm email notifications
set -euo pipefail

DEMO_ENV="${SMARTRETAIL_ENV:-demo-full}"
PROFILE="${AWS_PROFILE:-smartretail-demo-full}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ALERT_EMAIL="${CDK_CONTEXT_alertEmail:-}"
# All 6 ECS services (SIS included — required for Firehose HTTP endpoint delivery)
DEMO_SERVICES=(sis ims re ars dfs sup)
SKIP_INFRA=false

# --skip-infra  skips CDK + image build/push (steps 1–2c); runs migrations + MFE only
for arg in "$@"; do
  [[ "$arg" == "--skip-infra" ]] && SKIP_INFRA=true
done

CDK_DIR="$(cd "$(dirname "$0")/../infra" && pwd)"
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

hr() { printf '\n══ %s ══\n\n' "$1"; }

hr "SmartRetail Full-Stack Demo — Deploy"
echo "  Environment : $DEMO_ENV"
echo "  AWS Profile : $PROFILE"
echo "  Region      : $REGION"
echo "  Skip infra  : $SKIP_INFRA"
echo "  Alert email : ${ALERT_EMAIL:-'(not set — add CDK_CONTEXT_alertEmail to enable)'}"

ACCOUNT=$(AWS_PROFILE="$PROFILE" aws sts get-caller-identity --query Account --output text)

if [[ "$SKIP_INFRA" == false ]]; then
  # ── 1. CDK bootstrap (idempotent) ───────────────────────────────────────────
  hr "Step 1 / 5 — CDK bootstrap"
  cd "$CDK_DIR"
  npm install --silent
  AWS_PROFILE="$PROFILE" npx cdk bootstrap "aws://${ACCOUNT}/${REGION}"

  # ── 2a. CDK deploy pre-compute stacks (creates ECR repos + VPC) ─────────────
  hr "Step 2a / 5 — CDK deploy pre-compute stacks"
  ALERT_CTX=""
  if [[ -n "$ALERT_EMAIL" ]]; then
    ALERT_CTX="-c alertEmail=${ALERT_EMAIL}"
  fi
  AWS_PROFILE="$PROFILE" SMARTRETAIL_ENV="$DEMO_ENV" \
    npx cdk deploy \
      Full-NetworkStack Full-DataStack Full-MessagingStack Full-IdentityStack \
      --require-approval never $ALERT_CTX

  # ── 2b. Build and push service images (ECR repos now exist) ─────────────────
  hr "Step 2b / 5 — Build & push service images (${DEMO_SERVICES[*]})"
  cd "$ROOT_DIR"
  ECR_PREFIX="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

  AWS_PROFILE="$PROFILE" aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_PREFIX"

  mvn clean package -DskipTests \
    -pl backend/services/sis,backend/services/ims,backend/services/re,backend/services/ars,backend/services/dfs,backend/services/sup \
    -am --no-transfer-progress

  for svc in "${DEMO_SERVICES[@]}"; do
    echo "Building ${svc}..."
    docker buildx build --platform linux/arm64 \
      -t "smartretail-${svc}:local" "backend/services/${svc}/"
    docker tag "smartretail-${svc}:local" \
      "${ECR_PREFIX}/smartretail-${svc}-${DEMO_ENV}:latest"
    docker push "${ECR_PREFIX}/smartretail-${svc}-${DEMO_ENV}:latest"
  done

  # ── 2c. CDK deploy remaining stacks ─────────────────────────────────────────
  hr "Step 2c / 5 — CDK deploy compute + api + hosting + monitoring"
  cd "$CDK_DIR"
  AWS_PROFILE="$PROFILE" SMARTRETAIL_ENV="$DEMO_ENV" \
    npx cdk deploy \
      Full-ComputeStack Full-ApiStack Full-HostingStack Full-MonitoringStack \
      --require-approval never $ALERT_CTX
  cd "$ROOT_DIR"
else
  hr "Skipping infra (--skip-infra) — running migrations + MFE only"
fi

# ── 4. DB migrations (includes seed data via V7) ───────────────────────────────
hr "Step 4 / 5 — DB migrations + seed data"
AWS_PROFILE="$PROFILE" SMARTRETAIL_ENV="$DEMO_ENV" \
  "$ROOT_DIR/environments/demo-full/scripts/run-flyway-aws-demo-full.sh" "$DEMO_ENV"

# ── 5. SC Planner MFE ─────────────────────────────────────────────────────────
hr "Step 5 / 5 — Build & deploy SC Planner MFE"
cd "$ROOT_DIR/mfe/sc-planner"
npm install --silent
npm run build

# Generate runtime config.js with live SSM values — overwrites empty placeholder
API_ENDPOINT=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/api/endpoint" \
  --query Parameter.Value --output text 2>/dev/null || true)
COGNITO_POOL_ID=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/cognito/internal-pool-id" \
  --query Parameter.Value --output text 2>/dev/null || true)
COGNITO_CLIENT_ID=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/cognito/internal-client-id" \
  --query Parameter.Value --output text 2>/dev/null || true)

cat > dist/config.js <<CONFIGEOF
window.SMARTRETAIL_CONFIG = {
  apiGatewayEndpoint: '${API_ENDPOINT}',
  cognitoPoolId:      '${COGNITO_POOL_ID}',
  cognitoClientId:    '${COGNITO_CLIENT_ID}',
  cognitoDomain:      '',
  env:                '${DEMO_ENV}',
};
CONFIGEOF
echo "  apiGatewayEndpoint: ${API_ENDPOINT}"

BUCKET_NAME=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/hosting/sc-planner-bucket-name" \
  --query Parameter.Value --output text)
AWS_PROFILE="$PROFILE" aws s3 sync dist/ "s3://${BUCKET_NAME}/" --delete

# ── Summary ───────────────────────────────────────────────────────────────────
hr "Done"
SC_URL=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/hosting/sc-planner-url" \
  --query Parameter.Value --output text 2>/dev/null || echo "pending")
API_ENDPOINT=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/api/endpoint" \
  --query Parameter.Value --output text 2>/dev/null || echo "pending")
FIREHOSE_STREAM=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
  --name "/smartretail/${DEMO_ENV}/firehose/stream-name" \
  --query Parameter.Value --output text 2>/dev/null || echo "pending")
CW_URL="https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=SmartRetail-${DEMO_ENV}-Ops"

echo "  ✅  SC Planner      : $SC_URL"
echo "  ✅  API Endpoint    : $API_ENDPOINT"
echo "  ✅  Firehose Stream : $FIREHOSE_STREAM"
echo "  ✅  CW Dashboard    : $CW_URL"
echo ""
echo "  Cognito users not yet created."
echo "  Run: AWS_PROFILE=${PROFILE} SMARTRETAIL_ENV=${DEMO_ENV} ./scripts/shared/create-cognito-users.sh ${DEMO_ENV}"
echo ""
echo "  To tear down: SMARTRETAIL_ENV=${DEMO_ENV} AWS_PROFILE=${PROFILE} ./environments/demo-full/scripts/destroy-infra.sh"
