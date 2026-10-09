import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL_ID, DEFAULT_MODEL_ID } from '../../services/generator/src/core/models';
import { CoyoteStack, type CoyoteStackProps } from '../lib/coyote-stack';
import { PAGE_SCRIPT_HOSTS } from '../../services/generator/src/core/page-check';

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
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 6);
  });

  it('keeps both buckets private and versions the sites bucket', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: '_uploads/', ExpirationInDays: 1 })]) },
    });
  });

  it('never expires drafts', () => {
    const rules = Object.values(template.findResources('AWS::S3::Bucket')).flatMap((b) => b.Properties.LifecycleConfiguration?.Rules ?? []);
    expect(rules.filter((r: { Prefix?: string }) => r.Prefix === '_draft/' || r.Prefix === undefined).every((r: { ExpirationInDays?: number }) => r.ExpirationInDays === undefined)).toBe(true);
  });

  it('gives generated sites a CSP with inline scripts and the listed CDNs, no network access, and that only our app may frame', () => {
    const csp = cspOf(template, 'SitesHeaders');
    expect(/script-src ([^;]*);/.exec(csp)![1]).toBe(`'unsafe-inline' 'unsafe-eval' ${PAGE_SCRIPT_HOSTS.map((h) => `https://${h}`).join(' ')}`);
    expect(csp).not.toContain('connect-src'); // default-src 'none': scripts cannot fetch or send anything
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain('frame-src https://maps.google.com https://www.google.com');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('http://localhost:5173'); // this account is the development sandbox
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const [, sites] = Object.entries(policies).find(([id]) => id.startsWith('SitesHeaders'))!;
    expect(JSON.stringify(sites.Properties.ResponseHeadersPolicyConfig.CustomHeadersConfig)).toContain('X-Robots-Tag'); // drafts stay out of search
  });

  it('lets only the generate Lambda read the Anthropic API key, and gives it time for the page writer', () => {
    const readers = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) => JSON.stringify(p).includes('secretsmanager:GetSecretValue'));
    expect(readers).toHaveLength(1);
    expect(JSON.stringify(readers[0])).toContain('coyote/anthropic-api-key');
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 600, Environment: { Variables: Match.objectLike({ ANTHROPIC_SECRET_NAME: 'coyote/anthropic-api-key' }) } });
  });

  it('keeps the page-model switch in SSM, starting on Opus, readable only by the generate Lambda', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/coyote/page-model', Value: 'opus' });
    template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ PAGE_MODEL_PARAMETER: '/coyote/page-model' }) } });
    const readers = Object.keys(template.findResources('AWS::IAM::Policy')).filter((id) => JSON.stringify(template.findResources('AWS::IAM::Policy')[id]).includes('ssm:GetParameter'));
    expect(readers.map((id) => id.replace(/ServiceRoleDefaultPolicy.*$/, ''))).toEqual(['GeneratorApiGenerate']);
  });

  it('keeps the page-skill switch in SSM, starting on frontend-design, with the skills in a private bucket only generate reads', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/coyote/page-skill', Value: 'frontend-design' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ PAGE_SKILL_PARAMETER: '/coyote/page-skill', PAGE_SKILLS_BUCKET: Match.anyValue() }) },
    });
    const [bucketId] = Object.keys(template.findResources('AWS::S3::Bucket')).filter((id) => id.startsWith('PageSkillsBucket'));
    expect(template.findResources('AWS::S3::Bucket')[bucketId!]!.Properties.PublicAccessBlockConfiguration).toMatchObject({ BlockPublicAcls: true, RestrictPublicBuckets: true });
    const readers = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id, p]) => !id.startsWith('Custom') && JSON.stringify(p).includes(bucketId!))
      .map(([id]) => id.replace(/ServiceRoleDefaultPolicy.*$/, ''));
    expect(readers).toEqual(['GeneratorApiGenerate']);
    template.hasOutput('PageSkillsBucketName', {});
  });

  it('keeps the page-look switch in SSM, starting on', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/coyote/page-look', Value: 'on' });
    template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ PAGE_LOOK_PARAMETER: '/coyote/page-look' }) } });
  });

  it('keeps the page-images switch in SSM, starting on', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/coyote/page-images', Value: 'on' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ PAGE_IMAGES_PARAMETER: '/coyote/page-images', IMAGE_MODEL_ID: DEFAULT_IMAGE_MODEL_ID }) },
    });
  });

  it('keeps a framed draft out of the browser cache for top-level loads (Vary: Sec-Fetch-Dest)', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: { Items: Match.arrayWith([Match.objectLike({ Header: 'Vary', Value: 'Sec-Fetch-Dest' })]) },
      }),
    });
  });

  it('answers a missing app page with our 404 page and a 404 status', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Comment: 'coyote app',
        CustomErrorResponses: [
          Match.objectLike({ ErrorCode: 403, ResponseCode: 404, ResponsePagePath: '/404.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html' }),
        ],
      }),
    });
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
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties.RouteKey).sort();
    expect(routes).toEqual([
      'DELETE /me', 'GET /account', 'GET /jobs/{id}', 'GET /me', 'GET /me/chat', 'POST /account/login', 'POST /account/session', 'POST /generate',
      'POST /jobs/{id}/answers', 'POST /me/chat', 'POST /me/edit', 'POST /me/undo', 'POST /report/{slug}', 'POST /uploads',
    ]);
  });

  it('keeps the chat in its own table, and lets the chat poll above the stage limit', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'slug', KeyType: 'HASH' },
        { AttributeName: 'at', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 5 }),
      RouteSettings: { 'GET /me/chat': Match.objectLike({ ThrottlingRateLimit: 25 }) },
    });
    // Route settings fail to deploy if the stage is updated before the route exists.
    const routes = template.findResources('AWS::ApiGatewayV2::Route', { Properties: { RouteKey: 'GET /me/chat' } });
    const stage = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'))[0]!;
    expect(stage.DependsOn).toEqual(expect.arrayContaining(Object.keys(routes)));
  });

  it('only lets Lambdas call the text models with our guardrail attached', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown; Condition?: unknown }[],
    );
    const invoke = statements.filter((s) => [s.Action].flat().includes('bedrock:InvokeModel'));
    const [unguarded, text] = [invoke.filter((s) => !s.Condition), invoke.filter((s) => s.Condition)];
    expect(text.length).toBeGreaterThan(0);
    for (const statement of text) expect(JSON.stringify(statement.Condition)).toContain('bedrock:GuardrailIdentifier');
    expect(JSON.stringify(text)).toContain('inference-profile/us.amazon.nova-2-lite-v1:0'); // the pre-screen
    expect(JSON.stringify(text)).toContain('foundation-model/amazon.nova-2-lite-v1:0');
    const writer = text.filter((s) => JSON.stringify(s.Resource).includes(DEFAULT_MODEL_ID));
    expect(writer).toHaveLength(2); // generate (plan_site) and the chat
    for (const statement of writer) expect(statement.Action).toBe('bedrock:InvokeModel');
    // The only call without the guardrail: the image model in us-west-2, for generate only (images.ts screens it).
    expect(unguarded).toEqual([{ Action: 'bedrock:InvokeModel', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock:us-west-2::foundation-model/${DEFAULT_IMAGE_MODEL_ID}`]] } }]);
    const imagePolicies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([, p]) => JSON.stringify(p).includes(`foundation-model/${DEFAULT_IMAGE_MODEL_ID}`));
    expect(imagePolicies.map(([id]) => id.replace(/ServiceRoleDefaultPolicy.*$/, ''))).toEqual(['GeneratorApiGenerate']);
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

  it('sends email only with a verified sender, and only from the account and generate Lambdas', () => {
    template.resourceCountIs('AWS::SES::EmailIdentity', 0);
    const withSender = synth({ senderEmail: 'owner@example.test' });
    withSender.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'owner@example.test' });
    const senders = Object.entries(withSender.findResources('AWS::IAM::Policy'))
      .filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes('ses:SendEmail'))
      .map(([id]) => id.replace(/ServiceRoleDefaultPolicy.*$/, ''));
    expect(senders.sort()).toEqual(['GeneratorApiAccount', 'GeneratorApiGenerate']);
    const account = Object.values(withSender.findResources('AWS::Lambda::Function')).find((f) => JSON.stringify(f.Properties.Environment ?? {}).includes('owner@example.test'));
    expect(account).toBeDefined(); // SENDER_EMAIL reaches the Lambdas
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
    template.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: { Aliases: ['www.brand.test', 'brand.test'] } });
    template.resourceCountIs('AWS::Route53::RecordSet', 13); // 10 aliases (A + AAAA for www, the bare domain, sites, *.sites, api) + 3 DKIM records
  });

  it('sends email from no-reply@<domain> with DKIM', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'brand.test' });
    // The DKIM names SES gives are full names: the zone must not be appended to them again.
    const dkim = Object.values(template.findResources('AWS::Route53::RecordSet', { Properties: { Type: 'CNAME' } }));
    expect(dkim).toHaveLength(3);
    for (const record of dkim) expect(JSON.stringify(record.Properties.Name)).not.toContain('brand.test');
  });

  it('uses exact origins in the CSPs and the rewrite function', () => {
    expect(cspOf(template, 'SitesHeaders')).toContain('frame-ancestors https://www.brand.test http://localhost:5173');
    expect(cspOf(template, 'SitesHeaders')).toContain('form-action https://api.brand.test');
    expect(cspOf(template, 'AppHeaders')).toContain('frame-src https://draft.sites.test');
    expect(JSON.stringify(template.findResources('AWS::CloudFront::Function'))).toContain("var SITES_HOST = 'sites.test'");
  });

  it('rejects a half-configured domain setup', () => {
    expect(() => synth({ domainName: 'brand.test' })).toThrow(/domainless/);
  });
});
