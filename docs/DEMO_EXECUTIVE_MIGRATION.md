# Demo Environment: Executive Dashboard Migration

**Intent:** Replace the SC Planner demo with an Executive Dashboard demo.

| Axis | Before | After |
|------|--------|-------|
| Backend services | IMS, RE, ARS, DFS, SUP (5) | ARS, DFS (2) |
| MFE served | SC Planner (`/sc-planner/`) | Executive (`/executive/`) |
| CloudFront default path | `/sc-planner/` | `/executive/` |
| Cognito callbacks | `…/sc-planner/callback` | `…/executive/callback` |
| SQS queues | IMS sales, RE alert, ARS updates (6 queues + DLQs) | None |
| EventBridge rules | 2 (IMS→RE, IMS+RE→ARS) | 0 |

All changes are in `environments/demo/infra/lib/`, `.make/demo.mk`, `environments/demo/scripts/`, and `environments/demo/README.md`.

---

## 1. `environments/demo/infra/lib/data-stack.ts`

Remove ECR repositories for the three services being dropped.

```diff
--- a/environments/demo/infra/lib/data-stack.ts
+++ b/environments/demo/infra/lib/data-stack.ts
@@ -13,7 +13,7 @@ export interface DataStackProps extends cdk.StackProps {
 }
 
 // Services whose ECR repos must exist before ComputeStack deploys ECS services.
-const DEMO_SERVICES = ['ims', 're', 'ars', 'dfs', 'sup'] as const;
+const DEMO_SERVICES = ['ars', 'dfs'] as const;
 
 export class DataStack extends cdk.Stack {
```

---

## 2. `environments/demo/infra/lib/messaging-stack.ts`

Remove IMS sales queue, RE alert queue, ARS updates queue, and the two EventBridge routing rules. Only the EventBridge bus is retained (DFS still publishes events to it).

```diff
--- a/environments/demo/infra/lib/messaging-stack.ts
+++ b/environments/demo/infra/lib/messaging-stack.ts
@@ -9,9 +9,6 @@ export interface MessagingStackProps extends cdk.StackProps {
 
 /**
- * Demo messaging stack — SQS inter-service routing only, no POS ingestion queue.
- * SIS is not deployed in the demo; all data is pre-seeded. The three inter-service
- * queues (IMS, RE, ARS) are retained so RE can raise live alerts during demos.
+ * Demo messaging stack — EventBridge bus only.
+ * All sales/inventory/replenishment data is pre-seeded; no IMS/RE services run.
  */
 export class MessagingStack extends cdk.Stack {
   public readonly eventBus: events.EventBus;
-  public readonly imsSalesQueue: sqs.Queue;
-  public readonly imsSalesDlq: sqs.Queue;
-  public readonly reAlertQueue: sqs.Queue;
-  public readonly reAlertDlq: sqs.Queue;
-  public readonly arsUpdatesQueue: sqs.Queue;
-  public readonly arsUpdatesDlq: sqs.Queue;
-  public readonly alertToReRule: events.Rule;
-  public readonly allToArsRule: events.Rule;
 
   constructor(scope: Construct, id: string, props: MessagingStackProps) {
     super(scope, id, props);
@@ -35,56 +26,10 @@ export class MessagingStack extends cdk.Stack {
     this.eventBus = new events.EventBus(this, 'SmartRetailBus', {
       eventBusName: `smartretail-events-${srEnv}`,
     });
-
-    this.imsSalesDlq = new sqs.Queue(this, 'ImsSalesDlq', {
-      queueName: `smartretail-ims-sales-${srEnv}-dlq`,
-      encryption: sqs.QueueEncryption.SQS_MANAGED,
-      retentionPeriod: cdk.Duration.days(14),
-    });
-    this.imsSalesQueue = new sqs.Queue(this, 'ImsSalesQueue', {
-      queueName: `smartretail-ims-sales-${srEnv}`,
-      deadLetterQueue: { queue: this.imsSalesDlq, maxReceiveCount: 3 },
-      visibilityTimeout: cdk.Duration.seconds(120),
-    });
-
-    this.reAlertDlq = new sqs.Queue(this, 'ReAlertDlq', {
-      queueName: `smartretail-re-alert-${srEnv}-dlq.fifo`,
-      fifo: true,
-    });
-    this.reAlertQueue = new sqs.Queue(this, 'ReAlertQueue', {
-      queueName: `smartretail-re-alert-${srEnv}.fifo`,
-      fifo: true,
-      contentBasedDeduplication: true,
-      encryption: sqs.QueueEncryption.SQS_MANAGED,
-      deadLetterQueue: { queue: this.reAlertDlq, maxReceiveCount: 3 },
-      visibilityTimeout: cdk.Duration.seconds(120),
-    });
-
-    this.arsUpdatesDlq = new sqs.Queue(this, 'ArsUpdatesDlq', {
-      queueName: `smartretail-ars-updates-${srEnv}-dlq`,
-      retentionPeriod: cdk.Duration.days(14),
-    });
-    this.arsUpdatesQueue = new sqs.Queue(this, 'ArsUpdatesQueue', {
-      queueName: `smartretail-ars-updates-${srEnv}`,
-      encryption: sqs.QueueEncryption.SQS_MANAGED,
-      deadLetterQueue: { queue: this.arsUpdatesDlq, maxReceiveCount: 3 },
-    });
-
-    // IMS raises InventoryAlertEvent → RE picks up for PO creation
-    this.alertToReRule = new events.Rule(this, 'InventoryAlertToRe', {
-      eventBus: this.eventBus,
-      ruleName: `smartretail-alert-to-re-${srEnv}`,
-      eventPattern: { source: ['smartretail.ims'], detailType: ['InventoryAlertEvent'] },
-      targets: [new eventsTargets.SqsQueue(this.reAlertQueue, {
-        messageGroupId: events.EventField.fromPath('$.detail.dcId'),
-      })],
-    });
-
-    // All domain events → ARS for dashboard aggregation
-    this.allToArsRule = new events.Rule(this, 'AllEventsToArs', {
-      eventBus: this.eventBus,
-      ruleName: `smartretail-all-to-ars-${srEnv}`,
-      eventPattern: { source: ['smartretail.ims', 'smartretail.re'] },
-      targets: [new eventsTargets.SqsQueue(this.arsUpdatesQueue)],
-    });
 
     const put = (name: string, value: string) =>
       new ssm.StringParameter(this, name.replace(/[/-]/g, ''), {
@@ -93,10 +38,7 @@ export class MessagingStack extends cdk.Stack {
     put('eventbridge/bus-name',       this.eventBus.eventBusName);
     put('eventbridge/bus-arn',        this.eventBus.eventBusArn);
-    put('sqs/ims-sales-queue-url',    this.imsSalesQueue.queueUrl);
-    put('sqs/re-alert-queue-url',     this.reAlertQueue.queueUrl);
-    put('sqs/ars-updates-queue-url',  this.arsUpdatesQueue.queueUrl);
   }
 }
```

Also remove the unused import since `eventsTargets` and `sqs` are no longer referenced:

```diff
@@ -1,6 +1,4 @@
 import * as cdk from 'aws-cdk-lib';
 import * as events from 'aws-cdk-lib/aws-events';
-import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
-import * as sqs from 'aws-cdk-lib/aws-sqs';
 import * as ssm from 'aws-cdk-lib/aws-ssm';
 import { Construct } from 'constructs';
```

---

## 3. `environments/demo/infra/lib/compute-stack.ts`

Remove IMS, RE, and SUP services entirely. Keep only ARS and DFS.

```diff
--- a/environments/demo/infra/lib/compute-stack.ts
+++ b/environments/demo/infra/lib/compute-stack.ts
@@ -31,9 +31,8 @@ interface ServiceConfig {
 
 /**
- * Demo compute stack — SC Planner backend only (IMS, RE, ARS, DFS, SUP).
- * SIS is intentionally absent; all sales data is pre-seeded.
+ * Demo compute stack — Executive Dashboard backend only (ARS, DFS).
+ * All sales/inventory/replenishment data is pre-seeded; only ARS and DFS run live.
  * Container Insights enabled for CloudWatch observability.
  */
 export class ComputeStack extends cdk.Stack {
   public readonly cluster: ecs.Cluster;
-  public readonly imsService: ecs.FargateService;
-  public readonly reService: ecs.FargateService;
   public readonly arsService: ecs.FargateService;
   public readonly dfsService: ecs.FargateService;
-  public readonly supService: ecs.FargateService;
 
   constructor(scope: Construct, id: string, props: ComputeStackProps) {
@@ -88,55 +83,6 @@ export class ComputeStack extends cdk.Stack {
     };
 
-    const imsConfig: ServiceConfig = {
-      name: "ims",
-      port: 8081,
-      ecrRepo: data.ecrRepos["ims"],
-      envVars: {
-        ...commonEnv,
-        DB_SCHEMA: "inventory",
-        DB_USERNAME: "smartretail_admin",
-        IMS_SALES_QUEUE_URL: messaging.imsSalesQueue.queueUrl,
-        EVENTBRIDGE_BUS_NAME: messaging.eventBus.eventBusName,
-      },
-      secrets: commonSecrets,
-      policies: [
-        new iam.PolicyStatement({
-          actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
-          resources: [messaging.imsSalesQueue.queueArn],
-        }),
-        new iam.PolicyStatement({
-          actions: ["events:PutEvents"],
-          resources: [messaging.eventBus.eventBusArn],
-        }),
-        new iam.PolicyStatement({
-          actions: ["rds-db:connect"],
-          resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:*/smartretail_admin`],
-        }),
-      ],
-    };
-
-    const reConfig: ServiceConfig = {
-      name: "re",
-      port: 8082,
-      ecrRepo: data.ecrRepos["re"],
-      envVars: {
-        ...commonEnv,
-        DB_SCHEMA: "replenishment",
-        DB_USERNAME: "smartretail_admin",
-        RE_ALERT_QUEUE_URL: messaging.reAlertQueue.queueUrl,
-        EVENTBRIDGE_BUS_NAME: messaging.eventBus.eventBusName,
-      },
-      secrets: commonSecrets,
-      policies: [
-        new iam.PolicyStatement({
-          actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"],
-          resources: [messaging.reAlertQueue.queueArn],
-        }),
-        new iam.PolicyStatement({
-          actions: ["events:PutEvents"],
-          resources: [messaging.eventBus.eventBusArn],
-        }),
-        new iam.PolicyStatement({
-          actions: ["rds-db:connect"],
-          resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:*/smartretail_admin`],
-        }),
-      ],
-    };
-
     const arsConfig: ServiceConfig = {
@@ -161,22 +107,6 @@ export class ComputeStack extends cdk.Stack {
     };
 
-    const supConfig: ServiceConfig = {
-      name: "sup",
-      port: 8085,
-      ecrRepo: data.ecrRepos["sup"],
-      envVars: {
-        ...commonEnv,
-        DB_SCHEMA: "supplier",
-        DB_USERNAME: "smartretail_admin",
-        EVENTBRIDGE_BUS_NAME: messaging.eventBus.eventBusName,
-      },
-      secrets: commonSecrets,
-      policies: [
-        new iam.PolicyStatement({
-          actions: ["events:PutEvents"],
-          resources: [messaging.eventBus.eventBusArn],
-        }),
-        new iam.PolicyStatement({
-          actions: ["rds-db:connect"],
-          resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:*/smartretail_admin`],
-        }),
-      ],
-    };
-
-    this.imsService = this.createFargateService(imsConfig, network, ecsExecutionRole, srEnv);
-    this.reService = this.createFargateService(reConfig, network, ecsExecutionRole, srEnv);
     this.arsService = this.createFargateService(arsConfig, network, ecsExecutionRole, srEnv);
     this.dfsService = this.createFargateService(dfsConfig, network, ecsExecutionRole, srEnv);
-    this.supService = this.createFargateService(supConfig, network, ecsExecutionRole, srEnv);
 
     new ssm.StringParameter(this, "ClusterNameParam", {
```

---

## 4. `environments/demo/infra/lib/api-stack.ts`

Remove NLB listeners and API Gateway proxy resources for IMS, RE, and SUP.

```diff
--- a/environments/demo/infra/lib/api-stack.ts
+++ b/environments/demo/infra/lib/api-stack.ts
@@ -71,11 +71,8 @@ export class ApiStack extends cdk.Stack {
     };
 
-    addNlbListener('ims', 8081, compute.imsService);
-    addNlbListener('re',  8082, compute.reService);
     addNlbListener('ars', 8083, compute.arsService);
     addNlbListener('dfs', 8084, compute.dfsService);
-    addNlbListener('sup', 8085, compute.supService);
 
     // ── HTTP_PROXY integration helper ─────────────────────────────────────────
@@ -151,11 +148,8 @@ export class ApiStack extends cdk.Stack {
     // Staff APIs — five services, one proxy resource each
     const v1 = restApi.root.addResource('v1');
-    addProxyResource(v1, 'dashboard',     8083, '/v1/dashboard');     // ARS
-    addProxyResource(v1, 'inventory',     8081, '/v1/inventory');     // IMS
-    addProxyResource(v1, 'forecast',      8084, '/v1/forecast');      // DFS
-    addProxyResource(v1, 'replenishment', 8082, '/v1/replenishment'); // RE
-    addProxyResource(v1, 'supplier',      8085, '/v1/supplier');      // SUP
+    addProxyResource(v1, 'dashboard', 8083, '/v1/dashboard'); // ARS
+    addProxyResource(v1, 'forecast',  8084, '/v1/forecast');  // DFS
 
     this.apiEndpoint = restApi.url;
```

Also update the description comment on line 103:

```diff
@@ -101,7 +101,7 @@ export class ApiStack extends cdk.Stack {
     const restApi = new apigw.RestApi(this, 'RestApi', {
       restApiName: apiName,
-      description: 'SmartRetail Demo REST API — NLB VPC Link to ECS services',
+      description: 'SmartRetail Executive Dashboard Demo REST API — NLB VPC Link to ARS + DFS',
```

---

## 5. `environments/demo/infra/lib/hosting-stack.ts`

Swap every `sc-planner` reference for `executive` — bucket, OAC, CloudFront function names, behavior path, SSM parameter names, and the default redirect target.

```diff
--- a/environments/demo/infra/lib/hosting-stack.ts
+++ b/environments/demo/infra/lib/hosting-stack.ts
@@ -37,7 +37,7 @@ export class HostingStack extends cdk.Stack {
 
-    const bucket = new s3.Bucket(this, 'MfeBucketScPlanner', {
-      bucketName: `smartretail-mfe-${srEnv}-sc-planner-${account}`,
+    const bucket = new s3.Bucket(this, 'MfeBucketExecutive', {
+      bucketName: `smartretail-mfe-${srEnv}-executive-${account}`,
       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
       removalPolicy: cdk.RemovalPolicy.DESTROY,
       autoDeleteObjects: true,
@@ -47,7 +47,7 @@ export class HostingStack extends cdk.Stack {
     // Default behavior: redirect root to /executive/
     const defaultRedirectFn = new cloudfront.Function(this, 'DefaultRedirectFn', {
       functionName: `smartretail-${srEnv}-default-redirect`,
       code: cloudfront.FunctionCode.fromInline(
-        "function handler(event) { return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: '/sc-planner/' } } }; }"
+        "function handler(event) { return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: '/executive/' } } }; }"
       ),
       runtime: cloudfront.FunctionRuntime.JS_2_0,
     });
@@ -55,18 +55,18 @@ export class HostingStack extends cdk.Stack {
-    // /sc-planner/* behavior: OAC + SPA rewrite function
-    const oac = new cloudfront.S3OriginAccessControl(this, 'ScPlannerOac', {
-      originAccessControlName: `smartretail-${srEnv}-sc-planner-oac`,
+    // /executive/* behavior: OAC + SPA rewrite function
+    const oac = new cloudfront.S3OriginAccessControl(this, 'ExecutiveOac', {
+      originAccessControlName: `smartretail-${srEnv}-executive-oac`,
       signing: cloudfront.Signing.SIGV4_ALWAYS,
     });
 
-    const rewriteFn = new cloudfront.Function(this, 'ScPlannerRewriteFn', {
-      functionName: `smartretail-${srEnv}-sc-planner-rewrite`,
-      code: cloudfront.FunctionCode.fromInline(spaRewriteCode('/sc-planner')),
+    const rewriteFn = new cloudfront.Function(this, 'ExecutiveRewriteFn', {
+      functionName: `smartretail-${srEnv}-executive-rewrite`,
+      code: cloudfront.FunctionCode.fromInline(spaRewriteCode('/executive')),
       runtime: cloudfront.FunctionRuntime.JS_2_0,
     });
@@ -69,7 +69,7 @@ export class HostingStack extends cdk.Stack {
     const distribution = new cloudfront.Distribution(this, 'Distribution', {
-      comment: `SmartRetail SC Planner MFE (${srEnv})`,
+      comment: `SmartRetail Executive Dashboard MFE (${srEnv})`,
       priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
@@ -82,7 +82,7 @@ export class HostingStack extends cdk.Stack {
       additionalBehaviors: {
-        '/sc-planner/*': {
+        '/executive/*': {
           origin: scPlannerOrigin,
           viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
@@ -107,14 +107,14 @@ export class HostingStack extends cdk.Stack {
-    new ssm.StringParameter(this, 'ScPlannerUrlParam', {
-      parameterName: `/smartretail/${srEnv}/hosting/sc-planner-url`,
-      stringValue: `${this.distributionUrl}/sc-planner`,
+    new ssm.StringParameter(this, 'ExecutiveUrlParam', {
+      parameterName: `/smartretail/${srEnv}/hosting/executive-url`,
+      stringValue: `${this.distributionUrl}/executive`,
     });
 
-    new ssm.StringParameter(this, 'ScPlannerBucketNameParam', {
-      parameterName: `/smartretail/${srEnv}/hosting/sc-planner-bucket-name`,
+    new ssm.StringParameter(this, 'ExecutiveBucketNameParam', {
+      parameterName: `/smartretail/${srEnv}/hosting/executive-bucket-name`,
       stringValue: bucket.bucketName,
     });
@@ -117,7 +117,7 @@ export class HostingStack extends cdk.Stack {
     new cdk.CfnOutput(this, 'CloudFrontUrl', {
       value: this.distributionUrl,
-      description: 'SC Planner MFE CloudFront URL (HTTPS)',
+      description: 'Executive Dashboard MFE CloudFront URL (HTTPS)',
       exportName: `smartretail-${srEnv}-cloudfront-url`,
     });
```

Note: the `scPlannerOrigin` variable on line 67 is a local name only — rename it to `executiveOrigin` for clarity (two occurrences):

```diff
-    const scPlannerOrigin = origins.S3BucketOrigin.withOriginAccessControl(bucket, { originAccessControl: oac });
+    const executiveOrigin = origins.S3BucketOrigin.withOriginAccessControl(bucket, { originAccessControl: oac });
```

And update the two references in `defaultBehavior.origin` (line 73) and `additionalBehaviors['/executive/*'].origin` (line 83):

```diff
-      origin: scPlannerOrigin,   // line 73 — defaultBehavior
+      origin: executiveOrigin,

-      origin: scPlannerOrigin,   // line 83 — additionalBehaviors
+      origin: executiveOrigin,
```

---

## 6. `environments/demo/infra/lib/identity-stack.ts`

Update Cognito OAuth callback and logout URLs to point at the Executive MFE path.

```diff
--- a/environments/demo/infra/lib/identity-stack.ts
+++ b/environments/demo/infra/lib/identity-stack.ts
@@ -54,8 +54,8 @@ export class IdentityStack extends cdk.Stack {
         flows: { authorizationCodeGrant: true },
         scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
-        callbackUrls: [`${mfeBaseUrl}/sc-planner/callback`],
-        logoutUrls:   [`${mfeBaseUrl}/sc-planner/logout`],
+        callbackUrls: [`${mfeBaseUrl}/executive/callback`],
+        logoutUrls:   [`${mfeBaseUrl}/executive/logout`],
       },
```

---

## 7. `.make/demo.mk`

Seven changes: header comment, `DEMO_SERVICES`, `demo-build-services` docstring, `demo-deploy-mfe` target (build path, bucket SSM name, dist path, output URL), and `demo-full-deploy` step label + success message.

```diff
--- a/.make/demo.mk
+++ b/.make/demo.mk
@@ -1,7 +1,7 @@
-# ── Demo / SC Planner (cdk-demo, SC Planner only) ────────────────────────────
-# Deploys a trimmed SC Planner demo: 5 backend services (no SIS), 1 MFE, REST API + NLB.
+# ── Demo / Executive Dashboard (cdk-demo, Executive only) ─────────────────────
+# Deploys a trimmed Executive Dashboard demo: 2 backend services (ARS, DFS), 1 MFE, REST API + NLB.
 # Intended lifespan: 1-2 days. Tear down with `make demo-destroy`.
 # All resources tagged Lifecycle=ephemeral for easy cost tracking and cleanup.
 
@@ -7,7 +7,7 @@
 DEMO_ENV     ?= demo
 DEMO_PROFILE ?= $(PROFILE)
-DEMO_SERVICES = ims re ars dfs sup
+DEMO_SERVICES = ars dfs
 
 demo-bootstrap: ## Bootstrap CDK for demo environment (run once per account/region)
@@ -21,7 +21,7 @@
 
-demo-build-services: ## Build Docker images for the 5 SC Planner backend services
+demo-build-services: ## Build Docker images for the 2 Executive Dashboard backend services (ARS, DFS)
 	@for svc in $(DEMO_SERVICES); do \
@@ -62,16 +62,16 @@
-demo-deploy-mfe: ## Build and deploy SC Planner MFE to demo S3 bucket + invalidate CloudFront
-	cd mfe/sc-planner && npm install --silent && VITE_BASE_PATH=/sc-planner/ npm run build
+demo-deploy-mfe: ## Build and deploy Executive MFE to demo S3 bucket + invalidate CloudFront
+	cd mfe/executive && npm install --silent && VITE_BASE_PATH=/executive/ npm run build
 	@API_URL=$$(AWS_PROFILE=$(DEMO_PROFILE) aws ssm get-parameter \
 	    --name /smartretail/$(DEMO_ENV)/api/endpoint \
 	    --query Parameter.Value --output text); \
@@ -77,14 +77,14 @@
 	printf 'window.SMARTRETAIL_CONFIG = {\n  apiGatewayEndpoint: "%s",\n  cognitoPoolId:      "%s",\n  cognitoClientId:    "%s",\n  cognitoDomain:      "%s",\n  env:                "%s",\n};\n' \
 	    "$$API_URL" "$$POOL_ID" "$$CLIENT_ID" "$$DOMAIN" "$(DEMO_ENV)" \
-	    > mfe/sc-planner/dist/config.js; \
+	    > mfe/executive/dist/config.js; \
 	echo "config.js written (api: $$API_URL, domain: $$DOMAIN)"; \
 	BUCKET=$$(AWS_PROFILE=$(DEMO_PROFILE) aws ssm get-parameter \
-	    --name /smartretail/$(DEMO_ENV)/hosting/sc-planner-bucket-name \
+	    --name /smartretail/$(DEMO_ENV)/hosting/executive-bucket-name \
 	    --query Parameter.Value --output text); \
-	AWS_PROFILE=$(DEMO_PROFILE) aws s3 sync mfe/sc-planner/dist/ s3://$$BUCKET/ --delete; \
+	AWS_PROFILE=$(DEMO_PROFILE) aws s3 sync mfe/executive/dist/ s3://$$BUCKET/ --delete; \
 	CF_ID=$$(AWS_PROFILE=$(DEMO_PROFILE) aws ssm get-parameter \
 	    --name /smartretail/$(DEMO_ENV)/hosting/cloudfront-distribution-id \
 	    --query Parameter.Value --output text); \
 	echo "Invalidating CloudFront distribution $$CF_ID ..."; \
 	AWS_PROFILE=$(DEMO_PROFILE) aws cloudfront create-invalidation \
 	    --distribution-id "$$CF_ID" --paths "/*" --no-cli-pager \
 	    --query 'Invalidation.Status' --output text; \
-	echo "SC Planner URL: $$(AWS_PROFILE=$(DEMO_PROFILE) aws ssm get-parameter \
-	    --name /smartretail/$(DEMO_ENV)/hosting/sc-planner-url \
+	echo "Executive URL: $$(AWS_PROFILE=$(DEMO_PROFILE) aws ssm get-parameter \
+	    --name /smartretail/$(DEMO_ENV)/hosting/executive-url \
 	    --query Parameter.Value --output text)"
 
@@ -105,11 +105,11 @@
 	@echo "=== [3/5] DB migrations + seed data ==="
 	@make demo-migrate      DEMO_ENV=$(DEMO_ENV) DEMO_PROFILE=$(DEMO_PROFILE)
-	@echo "=== [4/5] SC Planner MFE ==="
+	@echo "=== [4/5] Executive MFE ==="
 	@make demo-deploy-mfe   DEMO_ENV=$(DEMO_ENV) DEMO_PROFILE=$(DEMO_PROFILE)
 	@echo "=== [5/5] Cognito users ==="
 	@make demo-create-users DEMO_ENV=$(DEMO_ENV) DEMO_PROFILE=$(DEMO_PROFILE)
 	@echo ""
-	@echo "✅  SC Planner demo ready (env: $(DEMO_ENV))"
+	@echo "✅  Executive Dashboard demo ready (env: $(DEMO_ENV))"
 	@echo "    Dashboard: https://$(REGION).console.aws.amazon.com/cloudwatch/home?region=$(REGION)#dashboards:name=SmartRetail-$(DEMO_ENV)-Ops"
```

---

## 8. `environments/demo/scripts/deploy-demo.sh`

Four changes: `DEMO_SERVICES` array, Maven `-pl` list, step-5 MFE build/deploy block, and the summary output.

```diff
--- a/environments/demo/scripts/deploy-demo.sh
+++ b/environments/demo/scripts/deploy-demo.sh
@@ -1,5 +1,5 @@
 #!/usr/bin/env bash
-# deploy-demo.sh — end-to-end SC Planner demo deployment (cdk-demo stack)
+# deploy-demo.sh — end-to-end Executive Dashboard demo deployment (cdk-demo stack)
 #
 # Usage:
@@ -17,7 +17,7 @@
 DEMO_ENV="${SMARTRETAIL_ENV:-demo}"
 PROFILE="${AWS_PROFILE:-smartretail-dev}"
 REGION="${AWS_DEFAULT_REGION:-us-east-1}"
 ALERT_EMAIL="${CDK_CONTEXT_alertEmail:-}"
-DEMO_SERVICES=(ims re ars dfs sup)
+DEMO_SERVICES=(ars dfs)
 SKIP_INFRA=false
 
@@ -30,7 +30,7 @@
-hr "SmartRetail SC Planner Demo — Deploy"
+hr "SmartRetail Executive Dashboard Demo — Deploy"
 
@@ -65,7 +65,7 @@
   mvn clean package -DskipTests \
-    -pl backend/services/ims,backend/services/re,backend/services/ars,backend/services/dfs,backend/services/sup \
+    -pl backend/services/ars,backend/services/dfs \
     -am --no-transfer-progress
 
@@ -95,24 +95,24 @@
-# ── 5. SC Planner MFE ─────────────────────────────────────────────────────────
-hr "Step 5 / 5 — Build & deploy SC Planner MFE"
-cd "$ROOT_DIR/mfe/sc-planner"
+# ── 5. Executive MFE ──────────────────────────────────────────────────────────
+hr "Step 5 / 5 — Build & deploy Executive MFE"
+cd "$ROOT_DIR/mfe/executive"
 npm install --silent
-npm run build
+VITE_BASE_PATH=/executive/ npm run build
 
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
-  --name "/smartretail/${DEMO_ENV}/hosting/sc-planner-bucket-name" \
+  --name "/smartretail/${DEMO_ENV}/hosting/executive-bucket-name" \
   --query Parameter.Value --output text)
 AWS_PROFILE="$PROFILE" aws s3 sync dist/ "s3://${BUCKET_NAME}/" --delete
 
@@ -129,12 +129,12 @@
 hr "Done"
-SC_URL=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
-  --name "/smartretail/${DEMO_ENV}/hosting/sc-planner-url" \
+EXEC_URL=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
+  --name "/smartretail/${DEMO_ENV}/hosting/executive-url" \
   --query Parameter.Value --output text 2>/dev/null || echo "pending")
 API_ENDPOINT=$(AWS_PROFILE="$PROFILE" aws ssm get-parameter \
   --name "/smartretail/${DEMO_ENV}/api/endpoint" \
   --query Parameter.Value --output text 2>/dev/null || echo "pending")
 CW_URL="https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=SmartRetail-${DEMO_ENV}-Ops"
 
-echo "  ✅  SC Planner  : $SC_URL"
+echo "  ✅  Executive   : $EXEC_URL"
 echo "  ✅  API Endpoint: $API_ENDPOINT"
 echo "  ✅  CW Dashboard: $CW_URL"
```

---

## 9. `environments/demo/scripts/deploy-services-demo.sh`

Update the header comment, default `SERVICES` variable, and Maven `-pl` list.

```diff
--- a/environments/demo/scripts/deploy-services-demo.sh
+++ b/environments/demo/scripts/deploy-services-demo.sh
@@ -1,6 +1,6 @@
 #!/usr/bin/env bash
-# Build Java services, push Docker images to ECR, force ECS redeployment.
-# cdk-demo target: IMS, RE, ARS, DFS, SUP only. No SIS. No Lambda (SQS-only).
+# Build Java services, push Docker images to ECR, force ECS redeployment.
+# cdk-demo target: ARS, DFS only (Executive Dashboard demo).
 #
 # Usage:
@@ -11,7 +11,7 @@
 #   --services  <ims,re,...>        Comma-separated subset of services to deploy
-#                                   (default: all five: ims,re,ars,dfs,sup)
+#                                   (default: ars,dfs)
@@ -30,7 +30,7 @@
 ENV="${SMARTRETAIL_ENV:-dev}"
 PROFILE="${AWS_PROFILE:-smartretail-dev}"
 REGION="${AWS_DEFAULT_REGION:-us-east-1}"
-SERVICES="ims re ars dfs sup"
+SERVICES="ars dfs"
 SKIP_BUILD=false
 
@@ -82,7 +82,7 @@
   echo ""
   echo "▶  Building service JARs (Maven)..."
   mvn clean package -DskipTests \
-    -pl backend/services/ims,backend/services/re,backend/services/ars,backend/services/dfs,backend/services/sup \
+    -pl backend/services/ars,backend/services/dfs \
     -am --no-transfer-progress
```

---

## 10. `environments/demo/scripts/deploy-mfes-demo.sh`

Update the script header, the default `MFES` value, the `--mfes` help text, and the hardcoded `/sc-planner` suffix in the CloudFront URL print at the end.

```diff
--- a/environments/demo/scripts/deploy-mfes-demo.sh
+++ b/environments/demo/scripts/deploy-mfes-demo.sh
@@ -1,12 +1,12 @@
 #!/usr/bin/env bash
-# Build React MFEs and sync dist/ to S3, then invalidate the shared CloudFront distribution.
-# Demo stack: sc-planner only, served via CloudFront (HTTPS).
+# Build React MFEs and sync dist/ to S3, then invalidate the shared CloudFront distribution.
+# Demo stack: executive only, served via CloudFront (HTTPS).
 #
 # Usage:
 #   ./environments/demo/scripts/deploy-mfes-demo.sh [OPTIONS]
 #
 # Options:
 #   --env       <demo|dev>      Environment name (default: $SMARTRETAIL_ENV or demo)
 #   --profile   <aws-profile>   AWS CLI profile (default: smartretail-dev)
-#   --mfes      <sc-planner>    Comma-separated MFEs to deploy (default: sc-planner)
+#   --mfes      <executive>     Comma-separated MFEs to deploy (default: executive)
 #   --skip-build                Skip npm build (use existing dist/)
 #
 # Examples:
@@ -23,7 +23,7 @@
 # ── Defaults ──────────────────────────────────────────────────────────────────
 ENV="${SMARTRETAIL_ENV:-demo}"
 PROFILE="${AWS_PROFILE:-smartretail-dev}"
-MFES="sc-planner"
+MFES="executive"
 SKIP_BUILD=false
 
@@ -130,7 +130,7 @@
     CF_URL=$(aws ssm get-parameter \
       --name "/smartretail/${ENV}/hosting/cloudfront-url" \
       --query Parameter.Value --output text \
       --profile "$PROFILE" 2>/dev/null || true)
-    [[ -n "$CF_URL" ]] && echo "   🌐  ${CF_URL}/sc-planner"
+    [[ -n "$CF_URL" ]] && echo "   🌐  ${CF_URL}/executive"
```

---

## 11. `environments/demo/README.md`

Full rewrite of the file. All SC Planner references become Executive Dashboard. Cost table updated to reflect 2 Fargate tasks instead of 5.

```diff
--- a/environments/demo/README.md
+++ b/environments/demo/README.md
@@ -1,8 +1,8 @@
-# AWS Demo Environment — SC Planner Demo Deployment
+# AWS Demo Environment — Executive Dashboard Demo Deployment
 
-Deploys the **SC Planner demo** on real AWS infrastructure. Intended lifespan: 1–2 days. All resources are tagged `Lifecycle=ephemeral` for easy cost tracking and cleanup.
+Deploys the **Executive Dashboard demo** on real AWS infrastructure. Intended lifespan: 1–2 days. All resources are tagged `Lifecycle=ephemeral` for easy cost tracking and cleanup.
 
-**What's deployed:** 5 backend services (IMS, RE, ARS, DFS, SUP — no SIS, no Lambda), SC Planner MFE only, REST API Gateway + internal NLB, SQS + EventBridge messaging, single-AZ RDS, CloudFront + S3 (OAC) for MFE hosting, Cognito for auth. Uses `environments/demo/infra/` (Min-* stack names).
+**What's deployed:** 2 backend services (ARS, DFS — pre-seeded data, no live ingestion), Executive Dashboard MFE, REST API Gateway + internal NLB, EventBridge bus, single-AZ RDS, CloudFront + S3 (OAC) for MFE hosting, Cognito for auth. Uses `environments/demo/infra/` (Min-* stack names).
 
 > For the full CDK stack spec and resource table see `environments/demo/infra/README.md`.
 
@@ -44,16 +44,16 @@
 
 ```bash
 # 1. Bootstrap CDK (once per account/region)
 make demo-bootstrap
 
-# 2a. Deploy pre-compute stacks only (creates ECR repos, RDS, Cognito, SQS)
+# 2a. Deploy pre-compute stacks only (creates ECR repos, RDS, Cognito, EventBridge bus)
 cd environments/demo/infra && AWS_PROFILE=smartretail-dev SMARTRETAIL_ENV=demo \
   npx cdk deploy Min-NetworkStack Min-DataStack Min-MessagingStack Min-IdentityStack \
   --require-approval never
 
-# 2b. Build and push 5 service images — ECR repos now exist
+# 2b. Build and push 2 service images — ECR repos now exist
 cd ../../..
 make demo-push-services DEMO_ENV=demo DEMO_PROFILE=smartretail-dev
 
 # 2c. Deploy remaining stacks (ECS can now pull images successfully)
 cd environments/demo/infra && AWS_PROFILE=smartretail-dev SMARTRETAIL_ENV=demo \
   npx cdk deploy Min-ComputeStack Min-ApiStack Min-HostingStack Min-MonitoringStack \
   --require-approval never
 
@@ -63,8 +63,8 @@
 make demo-push-flyway DEMO_ENV=demo DEMO_PROFILE=smartretail-dev
 make demo-migrate DEMO_ENV=demo DEMO_PROFILE=smartretail-dev
 
 # 3a. Reset database between demo runs
 make demo-reset-db DEMO_ENV=demo DEMO_PROFILE=smartretail-dev
 
-# 4. Build and deploy SC Planner MFE to S3
+# 4. Build and deploy Executive MFE to S3
 make demo-deploy-mfe DEMO_ENV=demo DEMO_PROFILE=smartretail-dev
 
 # 5. Create Cognito test users
@@ -93,8 +93,8 @@
 | Change | Command |
 |--------|---------|
 | Service code | `make demo-deploy-services` (build + push + force ECS redeploy) |
 | Single service (e.g. ars) | `docker buildx build … && docker push … && aws ecs update-service …` |
 | Flyway image | `make demo-push-flyway` |
-| MFE code | `make demo-deploy-mfe` |
+| Executive MFE code | `make demo-deploy-mfe` |
 | DB migration | `make demo-migrate` |
 | Reset DB between runs | `make demo-reset-db` |
-| Rebuild + redeploy services | `make demo-deploy-services` |
+| Rebuild + redeploy services (ARS, DFS) | `make demo-deploy-services` |
 | CDK infra only | `make demo-cdk-deploy` |
 
@@ -108,8 +108,8 @@
 
 **What gets stopped:**
 
 | Resource | Action | Resumes in |
 |----------|--------|------------|
-| ECS Fargate tasks (×5) | Desired count → 0 | ~30 s |
+| ECS Fargate tasks (×2) | Desired count → 0 | ~30 s |
 | RDS `t4g.micro` | `stop-db-instance` | ~2 min |
 
@@ -129,9 +129,9 @@
 
 ## After deployment
 
-**SC Planner URL:**
+**Executive Dashboard URL:**
 ```bash
-aws ssm get-parameter --name /smartretail/demo/hosting/sc-planner-url \
+aws ssm get-parameter --name /smartretail/demo/hosting/executive-url \
   --query Parameter.Value --output text
 ```
 
@@ -161,10 +161,10 @@
 
 | Service | Config | $/month |
 |---------|--------|---------|
 | RDS | t4g.micro, PostgreSQL 16, 20 GB, single-AZ | ~$14 |
-| ECS Fargate | 5 tasks × 0.25 vCPU / 0.5 GB, ARM64, on-demand | ~$36 |
+| ECS Fargate | 2 tasks × 0.25 vCPU / 0.5 GB, ARM64, on-demand | ~$14 |
 | NLB | 1 internal NLB, 2 listeners, low traffic | ~$7 |
 | CloudWatch | 1 dashboard, 6 alarms, 2 log groups | ~$3 |
 | Secrets Manager | 1 secret (RDS password) | ~$0.40 |
 | API Gateway (REST) | Low demo traffic (~100k calls) | ~$0.50 |
-| ECR | 5 repos, ~1 GB images | ~$0.05 |
+| ECR | 2 repos, ~500 MB images | ~$0.03 |
 | S3 / EventBridge / Cognito / SNS / SSM | Minimal usage, within free tiers | ~$0.50 |
-| **Total** | | **~$63/month** |
+| **Total** | | **~$39/month** |
 
 **Key points:**
-- RDS + Fargate = 79% of the bill. Pure on-demand FARGATE trades ~$19/month in savings for reliable deployments — worth it for a 1-2 day demo.
+- RDS + Fargate = 72% of the bill. Reduced service count cuts Fargate cost by 60% vs the SC Planner demo.
 - No NAT Gateway — tasks use public IPs in the default VPC, saving ~$32/month vs a private-subnet setup.
-- At ~$2.10/day, a 2-day demo costs ~$4.20. **Run `make demo-destroy` after every demo session.**
-- Running `make demo-stop` each evening (9 h off) cuts RDS + Fargate cost by ~37%, saving ~$0.60/night.
+- At ~$1.30/day, a 2-day demo costs ~$2.60. **Run `make demo-destroy` after every demo session.**
+- Running `make demo-stop` each evening (9 h off) cuts RDS + Fargate cost by ~40%, saving ~$0.35/night.
```

---

## Summary of touch points

| File | Nature of change |
|------|-----------------|
| `infra/lib/data-stack.ts` | `DEMO_SERVICES` array: 5 → 2 repos |
| `infra/lib/messaging-stack.ts` | Remove 6 SQS queues + 2 EventBridge rules; keep event bus only; remove `sqs`/`eventsTargets` imports |
| `infra/lib/compute-stack.ts` | Remove IMS, RE, SUP configs and public properties |
| `infra/lib/api-stack.ts` | Remove 3 NLB listeners and 3 API Gateway proxy resources |
| `infra/lib/hosting-stack.ts` | Rename bucket, OAC, CF functions, behavior path, SSM params from `sc-planner` → `executive` |
| `infra/lib/identity-stack.ts` | Cognito callback/logout URLs: `/sc-planner/` → `/executive/` |
| `.make/demo.mk` | `DEMO_SERVICES`, `demo-deploy-mfe` target, `demo-full-deploy` labels |
| `scripts/deploy-demo.sh` | `DEMO_SERVICES` array, Maven `-pl`, step 5 MFE block, summary variables |
| `scripts/deploy-services-demo.sh` | `SERVICES` default, Maven `-pl`, header comment |
| `scripts/deploy-mfes-demo.sh` | `MFES` default, `--mfes` help text, trailing URL print |
| `README.md` | Title, "what's deployed", granular steps, cost table, "after deployment" SSM param |

> **CDK note — existing `demo` environment:** if the Min-* stacks have already been deployed with the SC Planner configuration, the `HostingStack` resource IDs have changed (`MfeBucketScPlanner` → `MfeBucketExecutive`, `ScPlannerOac` → `ExecutiveOac`, etc.) and CDK will attempt to replace those resources. S3 buckets with `autoDeleteObjects: true` and `RemovalPolicy.DESTROY` will be deleted on replacement. Run `make demo-destroy` first if you have an existing `demo` stack, then do a fresh `make demo-full-deploy`.
