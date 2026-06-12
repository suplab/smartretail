#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack }    from '../lib/network-stack';
import { DataStack }       from '../lib/data-stack';
import { MessagingStack }  from '../lib/messaging-stack';
import { HostingStack }    from '../lib/hosting-stack';
import { IdentityStack }   from '../lib/identity-stack';
import { ComputeStack }    from '../lib/compute-stack';
import { ApiStack }        from '../lib/api-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

const env     = process.env.SMARTRETAIL_ENV ?? 'demo-full';
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID;
const region  = process.env.CDK_DEFAULT_REGION  ?? 'us-east-1';
const cdkEnv  = { account, region };

cdk.Tags.of(app).add('Project',     'smartretail');
cdk.Tags.of(app).add('Variant',     'full');
cdk.Tags.of(app).add('ManagedBy',   'cdk');
cdk.Tags.of(app).add('Environment', env);
cdk.Tags.of(app).add('Lifecycle',   'ephemeral');

const network   = new NetworkStack  (app, 'Full-NetworkStack',   { env: cdkEnv, srEnv: env });
const data      = new DataStack     (app, 'Full-DataStack',      { env: cdkEnv, srEnv: env, network });
const messaging = new MessagingStack(app, 'Full-MessagingStack', { env: cdkEnv, srEnv: env });
// Hosting before Identity — Identity needs the CloudFront URL for Cognito callback URLs
const hosting   = new HostingStack  (app, 'Full-HostingStack',   { env: cdkEnv, srEnv: env });
const identity  = new IdentityStack (app, 'Full-IdentityStack',  { env: cdkEnv, srEnv: env, mfeBaseUrl: hosting.distributionUrl });
const compute   = new ComputeStack  (app, 'Full-ComputeStack',   { env: cdkEnv, srEnv: env, network, data, messaging, identity });
const api       = new ApiStack      (app, 'Full-ApiStack',       { env: cdkEnv, srEnv: env, network, data, messaging, compute });
new MonitoringStack(app, 'Full-MonitoringStack', {
  env: cdkEnv, srEnv: env,
  compute, messaging, data, api,
  alertEmail: app.node.tryGetContext('alertEmail'),
});

app.synth();
