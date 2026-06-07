# SmartRetail Demo — Next Steps

_Last updated: 2026-06-07_

---

## 1. Deploy pending code fixes (RE, DFS, ARS, all services)

All code changes are local and built. AWS credentials must be valid before running.

### What was fixed

| Service | Fix | File(s) changed |
|---------|-----|-----------------|
| DFS | `demoSecurity` now parses JWT; OAuth2 autoconfigure exclusion removed | `SecurityConfig.java`, `application-demo.yml` |
| RE | Same JWT fix; `null` page/size default to `0`/`20` before unboxing | `SecurityConfig.java`, `application-demo.yml`, `ReplenishmentController.java` |
| ARS | `ScPlannerDashboardUseCase`, `SupplierPerformanceUseCase`, `ExecutiveDashboardUseCase` — parallel CompletableFutures replaced with sequential calls (free-tier RDS connection pressure) | 3 use-case files |
| All (7) | HikariCP pool sizes tuned: ARS/RE/DFS → 3, IMS/SUP/SIS/PPS → 2 | each `application.yml` |

### Deploy commands

```bash
# Rebuild
for svc in ars ims dfs re sup sis pps; do
  mvn clean package -DskipTests -q -f backend/services/$svc/pom.xml
done

# Push images + force ECS redeploy
AWS_PROFILE=smartretail-dev bash environments/demo/scripts/deploy-services-demo.sh ars ims dfs re sup sis pps

# Wait for stable
for svc in ars ims dfs re sup sis pps; do
  AWS_PROFILE=smartretail-dev aws ecs wait services-stable \
    --cluster smartretail-demo --services smartretail-${svc}-demo --region us-east-1
done
```

### Expected outcome
All SC Planner MFE errors resolved:
- `/v1/forecast/*` → 200 (was always 403 — DFS never parsed JWT)
- `/v1/replenishment/orders` → 200 (was 500 — null page NPE)
- `/v1/dashboard/sc-planner` → 200 (was 500 — connection pool exhaustion)
- `/v1/dashboard/supplier-performance` → 200 (same)

---

## 2. Add Store Manager MFE to demo

### What needs to change

#### `environments/demo/infra/lib/hosting-stack.ts`
- New S3 bucket: `smartretail-mfe-${srEnv}-store-manager-${account}`
- New OAC: `smartretail-${srEnv}-store-manager-oac`
- New CloudFront function: `smartretail-${srEnv}-store-manager-rewrite` using existing `spaRewriteCode('/store-manager')`
- New behavior: `'/store-manager/*'` → store-manager bucket, CACHING_OPTIMIZED, rewrite fn
- New SSM params: `/smartretail/${srEnv}/hosting/store-manager-url`, `/smartretail/${srEnv}/hosting/store-manager-bucket-name`
- Default redirect (`/` → `/sc-planner/`) stays unchanged

#### `environments/demo/infra/lib/identity-stack.ts`
```ts
callbackUrls: [
  `${mfeBaseUrl}/sc-planner/callback`,
  `${mfeBaseUrl}/store-manager/callback`,
],
logoutUrls: [
  `${mfeBaseUrl}/sc-planner/logout`,
  `${mfeBaseUrl}/store-manager/logout`,
],
```

#### `environments/demo/scripts/deploy-mfes-demo.sh`
- Update header comment: "sc-planner, store-manager"
- Update default `MFES="sc-planner"` (or `"sc-planner store-manager"` if both should deploy by default)
- The deploy loop already handles any MFE generically — bucket name is `smartretail-mfe-${ENV}-${MFE}-${ACCOUNT}` — no further loop changes needed
- Update the final `echo` line to print both MFE URLs

### Deploy commands (after code changes)

```bash
# 1. CDK deploy (creates new S3 bucket, CloudFront behavior, Cognito URLs)
cd environments/demo/infra
AWS_PROFILE=smartretail-dev npx cdk deploy Min-HostingStack Min-IdentityStack \
  --app "npx ts-node bin/app.ts" -c env=demo

# 2. Build + deploy store-manager MFE
AWS_PROFILE=smartretail-dev bash environments/demo/scripts/deploy-mfes-demo.sh \
  --mfes store-manager
```

### No backend changes needed
- ARS already has `STORE_MANAGER_ROLES = Set.of("STORE_MANAGER", "ADMIN")` — endpoint is guarded correctly
- `/v1/dashboard/*` API Gateway route already exists and points to ARS
- Cognito user `sm1@test.com` (STORE_MANAGER group) already in `create-cognito-users.sh`
- ARS pool size 3 is sufficient (Store Manager calls only 1 endpoint, polled every 60s)

### Verification
1. Navigate to `{cloudfront-url}/store-manager/` → Cognito login
2. Sign in as `sm1@test.com` / `Test@12345!`
3. Dashboard loads — `GET /v1/dashboard/store-manager?dcId=DC-LONDON` returns 200
4. `/sc-planner/` still works (no regression)
