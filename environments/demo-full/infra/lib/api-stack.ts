import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { NetworkStack } from "./network-stack";
import { DataStack } from "./data-stack";
import { MessagingStack } from "./messaging-stack";
import { ComputeStack } from "./compute-stack";

export interface ApiStackProps extends cdk.StackProps {
  srEnv: string;
  network: NetworkStack;
  data: DataStack;
  messaging: MessagingStack;
  compute: ComputeStack;
}

export class ApiStack extends cdk.Stack {
  public readonly apiEndpoint: string;
  public readonly firehoseStreamName: string;
  /** REST API name — used by MonitoringStack for CloudWatch metric dimensions (ApiName + Stage) */
  public readonly restApiName: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Name", "smartretail-api-full");

    const { srEnv, network, data, compute } = props;

    // ── Internal NLB ─────────────────────────────────────────────────────────
    // Demo-full uses the default VPC which has only public subnets — place NLB there.
    // REST API VpcLink is backed by NLB; all HTTP_PROXY routes share one link.
    const nlb = new elbv2.NetworkLoadBalancer(this, "Nlb", {
      loadBalancerName: `smartretail-nlb-${srEnv}`,
      vpc: network.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      crossZoneEnabled: true,
    });

    // ── VPC Link (REST API type — backed by NLB) ──────────────────────────────
    const vpcLink = new apigw.VpcLink(this, "VpcLink", {
      targets: [nlb],
      vpcLinkName: `smartretail-vpclink-${srEnv}`,
    });

    // ── NLB listeners + ECS target groups ────────────────────────────────────
    const addNlbListener = (name: string, port: number, service: ecs.FargateService): void => {
      const pascal = name.charAt(0).toUpperCase() + name.slice(1);
      const listener = nlb.addListener(`${pascal}Listener`, {
        port,
        protocol: elbv2.Protocol.TCP,
      });
      listener.addTargets(`${pascal}Tg`, {
        port,
        protocol: elbv2.Protocol.TCP,
        targets: [service.loadBalancerTarget({ containerName: `${name}Container`, containerPort: port })],
        healthCheck: {
          enabled: true,
          protocol: elbv2.Protocol.HTTP,
          path: "/actuator/health",
          port: String(port),
          interval: cdk.Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        deregistrationDelay: cdk.Duration.seconds(30),
      });
    };

    addNlbListener("sis", 8080, compute.sisService);
    addNlbListener("ims", 8081, compute.imsService);
    addNlbListener("re",  8082, compute.reService);
    addNlbListener("ars", 8083, compute.arsService);
    addNlbListener("dfs", 8084, compute.dfsService);
    addNlbListener("sup", 8085, compute.supService);

    // ── HTTP_PROXY integration helper ─────────────────────────────────────────
    // URI: http://{nlb-dns}:{port}{pathPrefix}/{proxy} — NLB routes to correct ECS TG.
    const nlbProxyIntegration = (port: number, pathPrefix: string) =>
      new apigw.Integration({
        type: apigw.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: "ANY",
        uri: `http://${nlb.loadBalancerDnsName}:${port}${pathPrefix}/{proxy}`,
        options: {
          connectionType: apigw.ConnectionType.VPC_LINK,
          vpcLink,
          requestParameters: {
            "integration.request.path.proxy": "method.request.path.proxy",
          },
        },
      });

    // ── REST API ──────────────────────────────────────────────────────────────
    const apiName = `smartretail-api-${srEnv}`;
    const restApi = new apigw.RestApi(this, "RestApi", {
      restApiName: apiName,
      description: "SmartRetail Demo-Full REST API — NLB VPC Link to ECS services",
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { stageName: "internal" },
    });

    const corsOptions: apigw.CorsOptions = {
      allowOrigins: apigw.Cors.ALL_ORIGINS,
      allowMethods: apigw.Cors.ALL_METHODS,
      allowHeaders: ["Authorization", "Content-Type", "X-Correlation-ID"],
      maxAge: cdk.Duration.hours(1),
    };

    const addProxyResource = (parent: apigw.IResource, pathPart: string, port: number, pathPrefix: string): void => {
      const resource = parent.addResource(pathPart);
      resource.addCorsPreflight(corsOptions);
      resource.addProxy({
        defaultIntegration: nlbProxyIntegration(port, pathPrefix),
        anyMethod: true,
        defaultMethodOptions: {
          requestParameters: { "method.request.path.proxy": true },
        },
        defaultCorsPreflightOptions: corsOptions,
      });
    };

    // Gateway Responses — inject CORS header on API GW-generated 4xx/5xx
    const corsHeaders = { "Access-Control-Allow-Origin": "'*'" };
    for (const type of [
      apigw.ResponseType.DEFAULT_4XX,
      apigw.ResponseType.DEFAULT_5XX,
      apigw.ResponseType.ACCESS_DENIED,
      apigw.ResponseType.UNAUTHORIZED,
    ]) {
      restApi.addGatewayResponse(`GwResp${type.responseType}`, {
        type,
        responseHeaders: corsHeaders,
      });
    }

    // Staff APIs — six services
    const v1 = restApi.root.addResource("v1");
    addProxyResource(v1, "ingest",        8080, "/v1/ingest");        // SIS (also Firehose target)
    addProxyResource(v1, "dashboard",     8083, "/v1/dashboard");     // ARS
    addProxyResource(v1, "inventory",     8081, "/v1/inventory");     // IMS
    addProxyResource(v1, "forecast",      8084, "/v1/forecast");      // DFS
    addProxyResource(v1, "replenishment", 8082, "/v1/replenishment"); // RE
    addProxyResource(v1, "supplier",      8085, "/v1/supplier");      // SUP

    this.apiEndpoint = restApi.url;
    this.restApiName = restApi.restApiName;

    // ── Firehose delivery stream ───────────────────────────────────────────────
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      roleName: `smartretail-firehose-${srEnv}`,
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });
    data.eventsBucket.grantWrite(firehoseRole);

    this.firehoseStreamName = `smartretail-ingest-${srEnv}`;

    new firehose.CfnDeliveryStream(this, "IngestStream", {
      deliveryStreamName: this.firehoseStreamName,
      deliveryStreamType: "DirectPut",
      httpEndpointDestinationConfiguration: {
        endpointConfiguration: {
          url: `${restApi.url}v1/ingest/events`,
          name: `smartretail-ingest-${srEnv}`,
          accessKey: data.firehoseAccessKeySecret.secretValue.toString(),
        },
        bufferingHints: { sizeInMBs: 1, intervalInSeconds: 60 },
        retryOptions: { durationInSeconds: 86400 },
        s3BackupMode: "AllData",
        s3Configuration: {
          bucketArn: data.eventsBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: { sizeInMBs: 5, intervalInSeconds: 60 },
          compressionFormat: "GZIP",
          prefix: "firehose/!{timestamp:yyyy/MM/dd}/",
          errorOutputPrefix: "firehose-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
        },
        roleArn: firehoseRole.roleArn,
      },
    });

    // ── Batch Post-Processor Lambda ───────────────────────────────────────────
    // Reads SageMaker transform output CSV, POSTs forecast results to DFS via
    // the API Gateway endpoint (no VPC — Lambda default network has internet access).
    const batchPostProcessorRepo = new ecr.Repository(this, "BatchPostProcessorRepo", {
      repositoryName: `smartretail-batch-post-processor-${srEnv}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const batchPostProcessorRole = new iam.Role(this, "BatchPostProcessorRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    batchPostProcessorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [data.sagemakerBucket.arnForObjects("sagemaker/output/*")],
    }));

    const batchPostProcessorFn = new lambda.DockerImageFunction(this, "BatchPostProcessor", {
      functionName: `smartretail-batch-post-processor-${srEnv}`,
      code: lambda.DockerImageCode.fromEcr(batchPostProcessorRepo),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(180),
      memorySize: 512,
      role: batchPostProcessorRole,
      environment: {
        DFS_ENDPOINT: `${restApi.url}v1/forecast`,
        SMARTRETAIL_ENV: srEnv,
      },
    });

    batchPostProcessorFn.addEventSource(new lambdaEventSources.S3EventSource(data.sagemakerBucket, {
      events: [s3.EventType.OBJECT_CREATED],
      filters: [{ prefix: "sagemaker/output/", suffix: ".csv" }],
    }));

    // ── ML Trigger Lambda ─────────────────────────────────────────────────────
    // Scheduled daily at 02:00 UTC — reads raw Firehose events from S3, writes
    // DeepAR training files to SageMaker bucket, starts SageMaker pipeline.
    // No VPC needed; calls SageMaker API and S3 directly via public endpoints.
    const mlTriggerRepo = new ecr.Repository(this, "MlTriggerRepo", {
      repositoryName: `smartretail-ml-trigger-${srEnv}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const mlTriggerRole = new iam.Role(this, "MlTriggerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const sagemakerPipelineName = `smartretail-demand-forecast-${srEnv}`;
    mlTriggerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sagemaker:StartPipelineExecution"],
      resources: [`arn:aws:sagemaker:${this.region}:${this.account}:pipeline/${sagemakerPipelineName}`],
    }));
    data.eventsBucket.grantRead(mlTriggerRole);
    data.sagemakerBucket.grantReadWrite(mlTriggerRole);

    const mlTriggerFn = new lambda.DockerImageFunction(this, "MlTrigger", {
      functionName: `smartretail-ml-trigger-${srEnv}`,
      code: lambda.DockerImageCode.fromEcr(mlTriggerRepo),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      role: mlTriggerRole,
      environment: {
        SAGEMAKER_PIPELINE_NAME: sagemakerPipelineName,
        EVENTS_BUCKET:           data.eventsBucket.bucketName,
        SAGEMAKER_BUCKET:        data.sagemakerBucket.bucketName,
        SAGEMAKER_ROLE_ARN:      data.sagemakerExecutionRole.roleArn,
        SMARTRETAIL_ENV:         srEnv,
      },
    });

    // Daily at 02:00 UTC — trigger SageMaker demand forecast pipeline
    const mlTriggerRule = new events.Rule(this, "MlTriggerSchedule", {
      ruleName: `smartretail-ml-trigger-daily-${srEnv}`,
      schedule: events.Schedule.cron({ hour: "2", minute: "0" }),
      description: "Daily SageMaker demand forecast pipeline trigger",
    });
    mlTriggerRule.addTarget(new eventsTargets.LambdaFunction(mlTriggerFn));

    // ── SSM outputs ───────────────────────────────────────────────────────────
    new ssm.StringParameter(this, "ApiEndpointParam", {
      parameterName: `/smartretail/${srEnv}/api/endpoint`,
      stringValue: restApi.url,
    });

    new ssm.StringParameter(this, "FirehoseStreamNameParam", {
      parameterName: `/smartretail/${srEnv}/firehose/stream-name`,
      stringValue: this.firehoseStreamName,
    });

    new ssm.StringParameter(this, "SageMakerPipelineNameParam", {
      parameterName: `/smartretail/${srEnv}/sagemaker/pipeline-name`,
      stringValue: sagemakerPipelineName,
    });

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: restApi.url,
      description: "SmartRetail Demo-Full REST API endpoint (internal stage)",
    });

    new cdk.CfnOutput(this, "FirehoseStreamName", {
      value: this.firehoseStreamName,
      description: "Kinesis Data Firehose delivery stream name",
    });
  }
}
