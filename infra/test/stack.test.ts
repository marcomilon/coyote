import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from '../../services/generator/src/core/models';
import { CoyoteStack, type CoyoteStackProps } from '../lib/coyote-stack';

const synth = (props: Partial<CoyoteStackProps> = {}) =>
  Template.fromStack(
    // Skip esbuild bundling: these tests only look at the template.
    new CoyoteStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Coyote-test', {
      env: { region: 'us-east-1' },
      webDist: fileURLToPath(new URL('../assets/sites-errors', import.meta.url)), // any folder: the tests do not need a frontend build
      ...props,
    }),
  );

const cspOf = (template: Template, idPrefix: string): string => {
  const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
  const [, policy] = Object.entries(policies).find(([id]) => id.startsWith(idPrefix))!;
  return JSON.stringify(policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy);
};

describe('CoyoteStack, domainless', () => {
  const template = synth();

  it('synthesizes without credentials and creates no DNS or certificates', () => {
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    template.resourceCountIs('AWS::CloudFront::Distribution', 2);
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 4);
  });

  it('keeps both buckets private and versions the sites bucket', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: '_preview/', ExpirationInDays: 1 })]) },
    });
  });

  it('gives generated sites a no-script CSP that only our app may frame', () => {
    const csp = cspOf(template, 'SitesHeaders');
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('http://localhost:5173'); // this account is the development sandbox
  });

  it('lets the app run its own scripts only', () => {
    const csp = cspOf(template, 'AppHeaders');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('throttles the API and lets the local frontend call it', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: { AllowOrigins: Match.arrayWith(['http://localhost:5173']) },
    });
  });

  it('defines the guardrail on the Standard tier with a pinned version', () => {
    template.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: { ContentFiltersTierConfig: { TierName: 'STANDARD' } },
      TopicPolicyConfig: {
        TopicsTierConfig: { TierName: 'STANDARD' },
        TopicsConfig: Match.arrayWith([Match.objectLike({ Name: 'Gambling', Type: 'DENY' })]),
      },
    });
    template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
    const topics = Object.values(template.findResources('AWS::Bedrock::Guardrail'))[0]!.Properties.TopicPolicyConfig.TopicsConfig;
    for (const topic of topics) {
      expect(topic.Definition.length, topic.Name).toBeLessThanOrEqual(200);
      for (const example of topic.Examples) expect(example.length, example).toBeLessThanOrEqual(100);
    }
  });

  it('exposes the routes', () => {
    for (const routeKey of ['POST /generate', 'GET /jobs/{id}', 'POST /jobs/{id}/publish', 'POST /jobs/{id}/regenerate', 'GET /me', 'DELETE /me', 'POST /me/content', 'POST /me/unpublish', 'POST /report/{slug}', 'POST /uploads']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
    }
  });

  it('only lets Lambdas call the text model with our guardrail attached', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown; Condition?: unknown }[],
    );
    const invoke = statements.filter((s) => [s.Action].flat().includes('bedrock:InvokeModel'));
    const [image, text] = [invoke.filter((s) => !s.Condition), invoke.filter((s) => s.Condition)];
    expect(text.length).toBeGreaterThan(0);
    for (const statement of text) expect(JSON.stringify(statement.Condition)).toContain('bedrock:GuardrailIdentifier');
    expect(JSON.stringify(text)).toContain('inference-profile/us.amazon.nova-2-lite-v1:0');
    expect(JSON.stringify(text)).toContain('foundation-model/amazon.nova-2-lite-v1:0');
    // Image models take no guardrail: the one unconditioned statement names only the image model.
    expect(image).toHaveLength(1);
    expect(JSON.stringify(image[0]!.Resource)).toContain(`${IMAGE_MODEL_REGION}::foundation-model/${DEFAULT_IMAGE_MODEL_ID}`);
    expect(JSON.stringify(image[0]!.Resource)).not.toContain('nova');
  });

  it('never retries a failed generation and records the failure', () => {
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      DestinationConfig: { OnFailure: Match.anyValue() },
    });
  });

  it('alarms on abuse and cost; email subscriptions are managed by coyote.sh, not the stack', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 9);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.resourceCountIs('AWS::CE::AnomalyMonitor', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('is disposable: cdk destroy removes all data', () => {
    template.allResources('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    template.allResources('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('exports the URLs the dev server and the Lambdas need', () => {
    for (const output of ['AppUrl', 'ApiUrl', 'SitesBaseUrl']) template.hasOutput(output, {});
  });
});

describe('CoyoteStack, domain mode', () => {
  const template = synth({
    env: { region: 'us-east-1', account: '123456789012' },
    domainName: 'brand.test',
    sitesDomainName: 'sites.test',
  });

  it('creates certificates, aliases, and DNS records', () => {
    template.resourceCountIs('AWS::CertificateManager::Certificate', 3);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'sites.test',
      SubjectAlternativeNames: ['*.sites.test'],
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: ['sites.test', '*.sites.test'] },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: { Aliases: ['app.brand.test'] } });
    template.resourceCountIs('AWS::Route53::RecordSet', 8);
  });

  it('uses exact origins in the CSPs and the rewrite function', () => {
    expect(cspOf(template, 'SitesHeaders')).toContain('frame-ancestors https://app.brand.test http://localhost:5173');
    expect(cspOf(template, 'SitesHeaders')).toContain('form-action https://api.brand.test');
    expect(cspOf(template, 'AppHeaders')).toContain('frame-src https://preview.sites.test');
    expect(JSON.stringify(template.findResources('AWS::CloudFront::Function'))).toContain("var SITES_HOST = 'sites.test'");
  });

  it('rejects a half-configured domain setup', () => {
    expect(() => synth({ domainName: 'brand.test' })).toThrow(/domainless/);
  });
});
