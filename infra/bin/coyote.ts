import { App } from 'aws-cdk-lib';
import { CoyoteStack, type CoyoteStackProps } from '../lib/coyote-stack';

const app = new App();

// Unset = domainless mode (see PLAN.md "Domains").
const domainName = app.node.tryGetContext('domainName') as string | undefined;

new CoyoteStack(app, 'Coyote', {
  // Domain mode looks up hosted zones, which needs a concrete account: the deploying profile's, or (synth with
  // no credentials, as in CI) the `account` in cdk.json, whose lookups are cached in cdk.context.json.
  env: { region: 'us-east-1', account: domainName ? (process.env.CDK_DEFAULT_ACCOUNT ?? (app.node.tryGetContext('account') as string | undefined)) : undefined },
  domainName,
  modelId: app.node.tryGetContext('modelId') as string | undefined,
  prescreenModelId: app.node.tryGetContext('prescreenModelId') as string | undefined,
  hostedZoneName: app.node.tryGetContext('hostedZoneName') as string | undefined,
  senderEmail: app.node.tryGetContext('senderEmail') as string | undefined,
  turnstileSiteKey: app.node.tryGetContext('turnstileSiteKey') as string | undefined,
  paddle: app.node.tryGetContext('paddle') as CoyoteStackProps['paddle'],
  mailMx: app.node.tryGetContext('mailMx') as CoyoteStackProps['mailMx'],
  apexTxt: app.node.tryGetContext('apexTxt') as string[] | undefined,
});
