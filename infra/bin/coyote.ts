import { App } from 'aws-cdk-lib';
import { CoyoteStack } from '../lib/coyote-stack';

const app = new App();

// Both unset = domainless mode (see PLAN.md "Domains").
const domainName = app.node.tryGetContext('domainName') as string | undefined;
const sitesDomainName = app.node.tryGetContext('sitesDomainName') as string | undefined;

new CoyoteStack(app, 'Coyote', {
  // Domain mode looks up hosted zones, which needs a concrete account.
  env: { region: 'us-east-1', account: domainName ? process.env.CDK_DEFAULT_ACCOUNT : undefined },
  domainName,
  sitesDomainName,
  modelId: app.node.tryGetContext('modelId') as string | undefined,
  imageModelId: app.node.tryGetContext('imageModelId') as string | undefined,
  hostedZoneName: app.node.tryGetContext('hostedZoneName') as string | undefined,
  sitesHostedZoneName: app.node.tryGetContext('sitesHostedZoneName') as string | undefined,
});
