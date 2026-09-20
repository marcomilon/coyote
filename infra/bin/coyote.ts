import { App } from 'aws-cdk-lib';
import { CoyoteStack, type EnvName } from '../lib/coyote-stack';

const app = new App();

const envName = app.node.tryGetContext('env') as string;
if (envName !== 'dev' && envName !== 'prod') {
  throw new Error(`context "env" must be "dev" or "prod", got "${envName}"`);
}

// Both unset = domainless mode (see PLAN.md "Domains").
const domainName = app.node.tryGetContext('domainName') as string | undefined;
const sitesDomainName = app.node.tryGetContext('sitesDomainName') as string | undefined;

new CoyoteStack(app, `Coyote-${envName}`, {
  env: { region: 'us-east-1' },
  envName: envName satisfies EnvName,
  domainName,
  sitesDomainName,
});
