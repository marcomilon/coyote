import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_apigatewayv2 as apigwv2,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_ses as ses,
  aws_sns as sns,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { DEFAULT_MODEL_ID, DEFAULT_PRESCREEN_MODEL_ID, hasTier } from '../../services/generator/src/core/models';
import { createUrls } from '../../services/generator/src/core/urls';
import { DEFAULT_PAGE_SKILL } from '../../services/generator/src/core/frontend-design';
import { EXAMPLE_SITES } from '../../services/generator/src/core/examples';
import { VOSEO_COUNTRIES } from '../../services/generator/src/core/i18n';
import { PAGE_FONT_HOSTS, PAGE_SCRIPT_HOSTS, PAGE_STYLE_HOSTS } from '../../services/generator/src/core/page-check';
import { appCsp, sitesCsp } from './csp';
import { GeneratorApi, type PaddleConfig } from './generator-api';
import { CoyoteGuardrail } from './guardrail';
import { Monitoring } from './monitoring';

/**
 * One stack, one environment. This AWS account is the development sandbox: localhost may call the API,
 * and `cdk destroy` deletes all data. A future production account deploys the same stack with a
 * production switch added then (see PLAN.md, launch gate).
 */
export interface CoyoteStackProps extends StackProps {
  /** Our one domain: app, API, email, private drafts (draft.<domain>), and the landing examples ({slug}.<domain>). Unset = domainless mode. */
  domainName?: string;
  /** Bedrock model or inference profile that writes the sites. Defaults to the one in services/generator/src/core/models.ts. */
  modelId?: string;
  /** Bedrock model or inference profile of the pre-screen classifier. Defaults to the one in models.ts. */
  prescreenModelId?: string;
  /** The built frontend. Defaults to web/dist (run `npm run build -w web` first). */
  webDist?: string;
  /** Route 53 zone that holds `domainName`. Defaults to `domainName`. */
  hostedZoneName?: string;
  /**
   * Domainless mode: the address our emails come from, verified in SES (👤 click the verification email). Unset =
   * no email ("Mis sitios" sign-in answers 503). Domain mode sends from no-reply@<domainName> instead.
   */
  senderEmail?: string;
  /** Cloudflare Turnstile's site key (public; the CAPTCHA on the anonymous forms). Unset = the forms show no widget. */
  turnstileSiteKey?: string;
  /** Paddle, the checkout of the design packs (public values). Unset = no checkout. */
  paddle?: PaddleConfig;
  /** Domain mode: MX records of the bare domain, for our own inbound mail (a forwarding service such as ImprovMX). */
  mailMx?: route53.MxRecordValue[];
  /**
   * Domain mode: the bare domain's TXT values (the forwarder's SPF, site verifications). Route 53 holds one TXT record
   * set per name, so a hand-made one must be deleted before the first deploy.
   */
  apexTxt?: string[];
}

const LOCAL_DEV_ORIGIN = 'http://localhost:5173';
const asset = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export class CoyoteStack extends Stack {
  readonly sitesBucket: s3.Bucket;
  readonly appBucket: s3.Bucket;
  readonly jobsTable: dynamodb.TableV2;
  readonly sitesTable: dynamodb.TableV2;
  readonly rateLimitTable: dynamodb.TableV2;
  readonly blocklistTable: dynamodb.TableV2;
  readonly chatTable: dynamodb.TableV2;
  readonly accountsTable: dynamodb.TableV2;
  readonly domainsTable: dynamodb.TableV2;
  readonly mailSuppressionTable: dynamodb.TableV2;
  readonly api: apigwv2.HttpApi;
  readonly guardrail: CoyoteGuardrail;
  readonly abuseReports: sns.Topic;
  /** Admin notices: every new site and every rejection (notices.ts; `./coyote.sh subscribe-alerts` subscribes to it too). */
  readonly siteNotices: sns.Topic;
  /** Env vars every Lambda needs to build URLs (see urls.ts `urlConfigFromEnv`). */
  readonly urlEnv: Record<string, string>;

  constructor(scope: Construct, id: string, props: CoyoteStackProps) {
    super(scope, id, props);

    Tags.of(this).add('project', 'coyote');

    // Every model belongs to a tier (models.ts MODELS): paid or free decides what the owner pays for.
    for (const id of [props.modelId, props.prescreenModelId]) {
      if (id && !hasTier(id)) throw new Error(`Model ${id} has no tier: add it to MODELS in services/generator/src/core/models.ts`);
    }

    const removalPolicy = RemovalPolicy.DESTROY;

    // Domain mode: every hostname is a plain string from urls.ts. Domainless: they are CloudFormation tokens.
    const domain = props.domainName ? this.domainSetup(props as CoyoteStackProps & { domainName: string }) : undefined;

    // ---------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------
    this.sitesBucket = new s3.Bucket(this, 'SitesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // Browsers upload photos straight to the bucket with a presigned POST, which is the credential.
      // Domainless mode cannot name the app origin here without a dependency cycle, so any origin may POST.
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: domain ? [domain.urls.appUrl, LOCAL_DEV_ORIGIN] : ['*'], allowedHeaders: ['*'], maxAge: 3600 }],
      removalPolicy,
      autoDeleteObjects: true,
      lifecycleRules: [
        { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'uploads', prefix: '_uploads/', expiration: Duration.days(1) },
        { id: 'aborted-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    this.appBucket = new s3.Bucket(this, 'AppBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: true,
    });

    // The page writer's skills (`./coyote.sh page-skill`): one `<name>.md` each, read by the generate Lambda per job,
    // so skills are added and switched without a deploy. The bundled default is written here.
    const pageSkillsBucket = new s3.Bucket(this, 'PageSkillsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'PageSkillsDefault', {
      sources: [s3deploy.Source.data(`${DEFAULT_PAGE_SKILL.name}.md`, DEFAULT_PAGE_SKILL.text)],
      destinationBucket: pageSkillsBucket,
      prune: false, // keep the skills added with ./coyote.sh page-skill add
    });
    // The page templates for template mode (`./coyote.sh page-mode template`): the repo's copy is the library.
    new s3deploy.BucketDeployment(this, 'PageTemplates', {
      sources: [s3deploy.Source.asset(asset('../../services/generator/templates'))],
      destinationBucket: pageSkillsBucket,
      destinationKeyPrefix: 'templates/',
    });

    const table = (name: string, partitionKey: string, ttl: boolean) =>
      new dynamodb.TableV2(this, name, {
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        billing: dynamodb.Billing.onDemand(),
        timeToLiveAttribute: ttl ? 'ttl' : undefined,
        removalPolicy,
      });
    this.jobsTable = table('JobsTable', 'jobId', true); // rows expire after 90 days
    this.sitesTable = table('SitesTable', 'slug', false);
    this.rateLimitTable = table('RateLimitTable', 'ip', true);
    this.blocklistTable = table('BlocklistTable', 'slug', false);
    // Owners' own domains (domains.ts). Kept when a site is deleted: the domain stays registered.
    this.domainsTable = table('DomainsTable', 'domain', false);
    // Addresses we never email again (core/mail-events.ts): a hard bounce or a complaint, by `emailId`.
    this.mailSuppressionTable = table('MailSuppressionTable', 'emailId', false);
    // The chat of each site (chat.ts): one row per message, ordered by `at` (ms). Rows expire after 90 days.
    this.chatTable = new dynamodb.TableV2(this, 'ChatTable', {
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'at', type: dynamodb.AttributeType.NUMBER },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy,
    });
    // "Mis sitios" (account.ts): `email#<id>` → profile + one row per site; `login#…` and `session#…` expire.
    this.accountsTable = new dynamodb.TableV2(this, 'AccountsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy,
    });

    // ---------------------------------------------------------------------------------------
    // App distribution (our frontend, JS allowed)
    // ---------------------------------------------------------------------------------------
    const appOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.appBucket);
    const appHeaders = new cloudfront.ResponseHeadersPolicy(this, 'AppHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: appCsp({
            // Domainless uses wildcards: the exact API and sites URLs would make the two
            // distributions and the API depend on each other in a circle.
            connectSrc: [
              "'self'", // /geo, the visitor's country
              domain ? domain.urls.apiUrl : `https://*.execute-api.${this.region}.amazonaws.com`,
              `https://${this.sitesBucket.bucketRegionalDomainName}`, // presigned photo uploads
            ],
            frameSrc: [domain ? domain.urls.draftOrigin : 'https://*.cloudfront.net'],
          }),
        },
        ...commonSecurityHeaders,
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });
    // CloudFront passes its geolocation headers to a function only when a policy lists them (/geo, and the vos rewrite).
    const viewerCountry = new cloudfront.OriginRequestPolicy(this, 'GeoHeaders', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('CloudFront-Viewer-Country'),
    });
    const appDistribution = new cloudfront.Distribution(this, 'AppDistribution', {
      comment: 'coyote app',
      domainNames: domain ? [domain.appHost, domain.bareHost] : undefined,
      certificate: domain?.appCertificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // A private bucket answers 403 for a missing key: visitors (and search engines) get our 404 page, as a 404.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: '/404.html',
        ttl: Duration.minutes(5),
      })),
      defaultBehavior: {
        origin: appOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'AppRewrite', {
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(
                readFileSync(asset('./cf-app-rewrite.js'), 'utf8')
                  .replace('__BARE_HOST__', domain ? domain.bareHost : '')
                  .replace('__APP_URL__', domain ? domain.urls.appUrl : '')
                  .replace('__VOSEO__', VOSEO_COUNTRIES.join(',')),
              ),
            }),
          },
        ],
        // The rewrite picks the vos pages by the visitor's country.
        originRequestPolicy: viewerCountry,
        responseHeadersPolicy: appHeaders,
      },
      additionalBehaviors: {
        // The visitor's country, answered by a function at the edge (cf-geo.js); the origin is never reached.
        '/geo': {
          origin: appOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: viewerCountry,
          responseHeadersPolicy: appHeaders,
          functionAssociations: [
            {
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              function: new cloudfront.Function(this, 'AppGeo', {
                runtime: cloudfront.FunctionRuntime.JS_2_0,
                code: cloudfront.FunctionCode.fromFile({ filePath: asset('./cf-geo.js') }),
              }),
            },
          ],
        },
      },
    });
    const appUrl = domain ? domain.urls.appUrl : `https://${appDistribution.distributionDomainName}`;

    // ---------------------------------------------------------------------------------------
    // Sites distribution (generated pages, no JS)
    // ---------------------------------------------------------------------------------------
    const rewriteSource = readFileSync(asset('./cf-rewrite.js'), 'utf8')
      .replace('__DOMAIN__', domain ? domain.bareHost : '')
      .replace('__APP_URL__', appUrl)
      .replace('__EXAMPLES__', EXAMPLE_SITES.join(','));

    const sitesDistribution = new cloudfront.Distribution(this, 'SitesDistribution', {
      comment: 'coyote sites',
      // draft.<domain> and the examples. The apex and www are the app distribution's (the more specific name wins).
      domainNames: domain ? [`*.${domain.bareHost}`] : undefined,
      certificate: domain?.sitesCertificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // A private bucket answers 403 for a missing key.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: '/_errors/404.html',
        ttl: Duration.minutes(1),
      })),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.sitesBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Short TTL: an owner's edit shows up within minutes without an invalidation.
        cachePolicy: new cloudfront.CachePolicy(this, 'SitesCache', {
          minTtl: Duration.seconds(0),
          defaultTtl: Duration.minutes(5),
          maxTtl: Duration.days(1),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'SitesRewrite', {
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(rewriteSource),
            }),
          },
        ],
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SitesHeaders', {
          securityHeadersBehavior: {
            contentSecurityPolicy: {
              override: true,
              contentSecurityPolicy: sitesCsp({
                // Used by the post-MVP contact form. Wildcard in domainless mode, as above.
                formAction: domain ? domain.urls.apiUrl : `https://*.execute-api.${this.region}.amazonaws.com`,
                frameAncestors: [appUrl, LOCAL_DEV_ORIGIN],
                scriptHosts: PAGE_SCRIPT_HOSTS,
                styleHosts: PAGE_STYLE_HOSTS,
                fontHosts: PAGE_FONT_HOSTS,
              }),
            },
            ...commonSecurityHeaders,
          },
          // Nothing is published yet: every page served here is a private draft or a landing example. Vary: a draft loaded in the app's
          // frame must not be reused by the browser cache when the same URL is opened in a tab (cf-rewrite.js
          // refuses top-level loads, but only for requests that reach CloudFront).
          customHeadersBehavior: {
            customHeaders: [
              { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
              { header: 'Vary', value: 'Sec-Fetch-Dest', override: true },
            ],
          },
        }),
      },
    });
    const sitesBaseUrl = `https://${sitesDistribution.distributionDomainName}`;

    new s3deploy.BucketDeployment(this, 'SitesErrorPages', {
      sources: [s3deploy.Source.asset(asset('../assets/sites-errors'))],
      destinationBucket: this.sitesBucket,
      destinationKeyPrefix: '_errors/',
      prune: false, // never delete generated sites
    });

    // The landing page's example sites (examples.ts). Pruning stays inside the _examples/ prefix.
    new s3deploy.BucketDeployment(this, 'SitesExamples', {
      sources: [s3deploy.Source.asset(asset('../../examples/sites'))],
      destinationBucket: this.sitesBucket,
      destinationKeyPrefix: '_examples/',
    });
    const exampleUrls = Object.fromEntries(
      EXAMPLE_SITES.map((slug) => [slug, domain ? domain.urls.exampleUrl(slug) : `${sitesBaseUrl}/${slug}/`]),
    );

    // ---------------------------------------------------------------------------------------
    // API (the routes are added by GeneratorApi below)
    // ---------------------------------------------------------------------------------------
    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'coyote',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [appUrl, LOCAL_DEV_ORIGIN],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: Duration.hours(1),
      },
    });
    const apiStage = new apigwv2.HttpStage(this, 'ApiStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      // Shared by everyone. Per visitor: a per-minute limit in every API Lambda (perIpLimit) and the daily quotas.
      throttle: { rateLimit: 50, burstLimit: 100 },
      domainMapping: domain ? { domainName: domain.apiDomain } : undefined,
    });
    const apiUrl = domain ? domain.urls.apiUrl : this.api.apiEndpoint;

    const webDist = props.webDist ?? asset('../../web/dist');
    if (!existsSync(webDist)) throw new Error(`${webDist} does not exist. Build the frontend first: npm run build -w web`);
    const appDeployment = new s3deploy.BucketDeployment(this, 'AppDeployment', {
      // config.js is excluded (and so never pruned): a local one (written for `astro dev`) must never reach the bucket.
      sources: [s3deploy.Source.asset(webDist, { exclude: ['config.js'] })],
      exclude: ['config.js'],
      destinationBucket: this.appBucket,
      distribution: appDistribution,
      distributionPaths: ['/*'],
    });
    // config.js on its own, with no-cache: browsers would otherwise keep an old one (no new example links, an old API URL).
    new s3deploy.BucketDeployment(this, 'AppConfigDeployment', {
      sources: [s3deploy.Source.data('config.js', `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl, examples: exampleUrls, ...(props.turnstileSiteKey ? { turnstileSiteKey: props.turnstileSiteKey } : {}), ...(props.paddle ? { paddle: { env: props.paddle.env, clientToken: props.paddle.clientToken } } : {}), ...(domain?.urls.supportEmail ? { supportEmail: domain.urls.supportEmail } : {}) })};\n`)],
      destinationBucket: this.appBucket,
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: appDistribution,
      distributionPaths: ['/config.js'],
    }).node.addDependency(appDeployment);

    // ---------------------------------------------------------------------------------------
    // Safety
    // ---------------------------------------------------------------------------------------
    this.guardrail = new CoyoteGuardrail(this, 'Guardrail');
    this.abuseReports = new sns.Topic(this, 'AbuseReports', { displayName: 'Coyote abuse reports' });
    this.siteNotices = new sns.Topic(this, 'SiteNotices', { displayName: 'Coyote site notices' });

    // ---------------------------------------------------------------------------------------
    // DNS (domain mode only)
    // ---------------------------------------------------------------------------------------
    if (domain) {
      const alias = (name: string, zone: route53.IHostedZone, recordName: string, target: route53.IAliasRecordTarget) => {
        const recordTarget = route53.RecordTarget.fromAlias(target);
        new route53.ARecord(this, `${name}A`, { zone, recordName, target: recordTarget });
        new route53.AaaaRecord(this, `${name}Aaaa`, { zone, recordName, target: recordTarget });
      };
      alias('AppRecord', domain.zone, domain.appHost, new targets.CloudFrontTarget(appDistribution));
      alias('AppBareRecord', domain.zone, domain.bareHost, new targets.CloudFrontTarget(appDistribution)); // redirects to www
      // draft.<domain> and the examples; www, api and the validation/DKIM records are explicit, so they win.
      alias('SitesWildcardRecord', domain.zone, `*.${domain.bareHost}`, new targets.CloudFrontTarget(sitesDistribution));
      alias(
        'ApiRecord',
        domain.zone,
        domain.apiHost,
        new targets.ApiGatewayv2DomainProperties(domain.apiDomain.regionalDomainName, domain.apiDomain.regionalHostedZoneId),
      );
    }

    this.urlEnv = domain
      ? { DOMAIN_NAME: props.domainName! }
      : { APP_BASE_URL: appUrl, API_BASE_URL: apiUrl, SITES_BASE_URL: sitesBaseUrl, ...(props.senderEmail ? { SENDER_EMAIL: props.senderEmail } : {}) };

    // ---------------------------------------------------------------------------------------
    // Email (SES): sign-in links and "your site is ready"
    // ---------------------------------------------------------------------------------------
    // Bounces and complaints: the identity's default configuration set publishes them to SNS, and the mail-events
    // Lambda suppresses the addresses (core/mail-events.ts). Every email goes through the identity, so through the set.
    const mailConfigurationSet = props.senderEmail || domain ? new ses.ConfigurationSet(this, 'MailConfigurationSet') : undefined;
    const mailEvents = mailConfigurationSet ? new sns.Topic(this, 'MailEvents', { displayName: 'Coyote SES bounces and complaints' }) : undefined;
    if (mailConfigurationSet && mailEvents) {
      mailConfigurationSet.addEventDestination('BouncesAndComplaints', {
        destination: ses.EventDestination.snsTopic(mailEvents),
        events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
      });
    }
    let mailIdentity: ses.EmailIdentity | undefined;
    if (domain) {
      const mailDomain = domain.urls.mailFrom!.split('@')[1]!;
      mailIdentity = new ses.EmailIdentity(this, 'MailIdentity', { identity: ses.Identity.domain(mailDomain), configurationSet: mailConfigurationSet });
      // SES gives full names; they are tokens at synth, so CDK can't see they already end in the zone and would
      // append it again. The trailing dot marks them as fully qualified.
      mailIdentity.dkimRecords.forEach((record, i) => new route53.CnameRecord(this, `MailDkim${i}`, { zone: domain.zone, recordName: `${record.name}.`, domainName: record.value }));
      // Our own inbound mail (info@ and the like) goes to a forwarding service, never to SES: forwarded spam would count
      // against the account that sends the sign-in links.
      if (props.mailMx?.length) new route53.MxRecord(this, 'MailMx', { zone: domain.zone, values: props.mailMx });
      if (props.apexTxt?.length) new route53.TxtRecord(this, 'ApexTxt', { zone: domain.zone, values: props.apexTxt });
    } else if (props.senderEmail) {
      mailIdentity = new ses.EmailIdentity(this, 'MailIdentity', { identity: ses.Identity.email(props.senderEmail), configurationSet: mailConfigurationSet });
    }

    const generatorApi = new GeneratorApi(this, 'GeneratorApi', {
      api: this.api,
      jobsTable: this.jobsTable,
      sitesTable: this.sitesTable,
      rateLimitTable: this.rateLimitTable,
      blocklistTable: this.blocklistTable,
      chatTable: this.chatTable,
      accountsTable: this.accountsTable,
      domainsTable: this.domainsTable,
      mailIdentity,
      mailConfigurationSet,
      mailEvents,
      mailSuppressionTable: this.mailSuppressionTable,
      sitesBucket: this.sitesBucket,
      pageSkillsBucket,
      sitesDistribution,
      guardrail: this.guardrail,
      abuseReports: this.abuseReports,
      siteNotices: this.siteNotices,
      modelId: props.modelId ?? DEFAULT_MODEL_ID,
      prescreenModelId: props.prescreenModelId ?? DEFAULT_PRESCREEN_MODEL_ID,
      rateLimitPerDay: 100, // sandbox account; production uses 3
      urlEnv: this.urlEnv,
      paddle: props.paddle,
    });

    // Routes that do costly work (model calls, emails, uploads) get their own, lower limit, so a flood on one of them
    // leaves the rest of the API to everyone else. The chat polls every few seconds.
    const routeThrottles: Record<string, [rate: number, burst: number]> = {
      'POST /generate': [5, 10],
      'POST /jobs/{id}/answers': [5, 10],
      'POST /uploads': [5, 10],
      'POST /report/{slug}': [2, 5],
      'POST /account/login': [2, 5],
      'POST /me/chat': [5, 10],
      'POST /me/edit': [5, 10],
      'POST /me/design': [5, 10],
      'GET /me/chat': [25, 50],
      'GET /me/domain/check': [2, 5], // each check asks the registry about every TLD; the registrar allows 10 per 10 s
      'POST /me/domain': [1, 2],
      ...(props.paddle && { 'POST /me/checkout': [2, 5] as [number, number], 'POST /me/billing/portal': [2, 5] as [number, number], 'POST /paddle/webhook': [20, 50] as [number, number] }),
    };
    (apiStage.node.defaultChild as apigwv2.CfnStage).addPropertyOverride(
      'RouteSettings',
      Object.fromEntries(Object.entries(routeThrottles).map(([key, [rate, burst]]) => [key, { ThrottlingRateLimit: rate, ThrottlingBurstLimit: burst }])),
    );
    for (const key of Object.keys(routeThrottles)) {
      const route = generatorApi.routes.get(key);
      if (!route) throw new Error(`No API route ${key}`);
      apiStage.node.addDependency(route); // the route must exist before its settings
    }

    new Monitoring(this, 'Monitoring', {
      api: this.api,
      generate: generatorApi.generate,
      abuseReports: this.abuseReports,
      mailEvents: generatorApi.mailEvents,
      domainOrdersDeadLetters: generatorApi.domainOrdersDeadLetters,
      monthlyBudgetUsd: 20,
    });

    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'SitesBaseUrl', { value: domain ? domain.urls.draftOrigin : sitesBaseUrl });
    // The landing examples' URLs, for the local config.js (scripts/write-config.mjs).
    if (props.turnstileSiteKey) new CfnOutput(this, 'TurnstileSiteKey', { value: props.turnstileSiteKey });
    new CfnOutput(this, 'ExampleUrls', { value: this.toJsonString(exampleUrls) });
    new CfnOutput(this, 'SitesBucketName', { value: this.sitesBucket.bucketName });
    new CfnOutput(this, 'PageSkillsBucketName', { value: pageSkillsBucket.bucketName });
    // For the admin commands in coyote.sh.
    new CfnOutput(this, 'SitesDistributionId', { value: sitesDistribution.distributionId });
    new CfnOutput(this, 'JobsTableName', { value: this.jobsTable.tableName });
    new CfnOutput(this, 'SitesTableName', { value: this.sitesTable.tableName });
    new CfnOutput(this, 'RateLimitTableName', { value: this.rateLimitTable.tableName });
    new CfnOutput(this, 'BlocklistTableName', { value: this.blocklistTable.tableName });
    new CfnOutput(this, 'ChatTableName', { value: this.chatTable.tableName });
    new CfnOutput(this, 'AccountsTableName', { value: this.accountsTable.tableName });
    new CfnOutput(this, 'DomainsTableName', { value: this.domainsTable.tableName });
    if (generatorApi.domainOrders) new CfnOutput(this, 'DomainOrdersQueueUrl', { value: generatorApi.domainOrders.queueUrl });
    new CfnOutput(this, 'GuardrailId', { value: this.guardrail.guardrailId });
    new CfnOutput(this, 'GuardrailVersion', { value: this.guardrail.version });
  }

  /** Certificates, hosted zones, and hostnames. Needs AWS credentials at synth (hosted-zone lookup). */
  private domainSetup(props: CoyoteStackProps & { domainName: string }) {
    const urls = createUrls({ mode: 'domain', domainName: props.domainName });
    const appHost = new URL(urls.appUrl).host; // www.<domain>
    const bareHost = props.domainName;
    const apiHost = new URL(urls.apiUrl).host;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZoneName ?? props.domainName });

    // The stack is in us-east-1, which is where CloudFront needs its certificates.
    const appCertificate = new acm.Certificate(this, 'AppCertificate', {
      domainName: appHost,
      subjectAlternativeNames: [bareHost],
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const sitesCertificate = new acm.Certificate(this, 'SitesCertificate', {
      domainName: `*.${bareHost}`,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const apiDomain = new apigwv2.DomainName(this, 'ApiDomain', {
      domainName: apiHost,
      certificate: new acm.Certificate(this, 'ApiCertificate', {
        domainName: apiHost,
        validation: acm.CertificateValidation.fromDns(zone),
      }),
    });

    return { urls, appHost, bareHost, apiHost, zone, appCertificate, sitesCertificate, apiDomain };
  }
}

const commonSecurityHeaders = {
  strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
  contentTypeOptions: { override: true },
  referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
} satisfies Partial<cloudfront.ResponseSecurityHeadersBehavior>;
