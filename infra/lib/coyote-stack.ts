import { readFileSync } from 'node:fs';
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
  aws_sns as sns,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { createUrls } from '../../services/generator/src/core/urls';
import { appCsp, sitesCsp } from './csp';
import { CoyoteGuardrail } from './guardrail';

/**
 * One stack, one environment. This AWS account is the development sandbox: localhost may call the API,
 * and `cdk destroy` deletes all data. A future production account deploys the same stack with a
 * production switch added then (see PLAN.md, launch gate).
 */
export interface CoyoteStackProps extends StackProps {
  /** Brand domain (app, API, email). Unset = domainless mode. */
  domainName?: string;
  /** Registrable domain for user sites. Unset = domainless mode. */
  sitesDomainName?: string;
  /** Route 53 zone that holds `domainName`. Defaults to `domainName`. */
  hostedZoneName?: string;
  /** Route 53 zone that holds `sitesDomainName`. Defaults to `sitesDomainName`. */
  sitesHostedZoneName?: string;
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
  readonly api: apigwv2.HttpApi;
  readonly guardrail: CoyoteGuardrail;
  readonly abuseReports: sns.Topic;
  /** Env vars every Lambda needs to build URLs (see urls.ts `urlConfigFromEnv`). */
  readonly urlEnv: Record<string, string>;

  constructor(scope: Construct, id: string, props: CoyoteStackProps) {
    super(scope, id, props);

    if (Boolean(props.domainName) !== Boolean(props.sitesDomainName)) {
      throw new Error('Set both domainName and sitesDomainName, or neither (domainless mode).');
    }

    Tags.of(this).add('project', 'coyote');

    const removalPolicy = RemovalPolicy.DESTROY;

    // Domain mode: every hostname is a plain string from urls.ts. Domainless: they are CloudFormation tokens.
    const domain =
      props.domainName && props.sitesDomainName
        ? this.domainSetup(props as CoyoteStackProps & { domainName: string; sitesDomainName: string })
        : undefined;

    // ---------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------
    this.sitesBucket = new s3.Bucket(this, 'SitesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: true,
      lifecycleRules: [
        { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'previews', prefix: '_preview/', expiration: Duration.days(1) },
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

    // ---------------------------------------------------------------------------------------
    // App distribution (our frontend, JS allowed)
    // ---------------------------------------------------------------------------------------
    const appDistribution = new cloudfront.Distribution(this, 'AppDistribution', {
      comment: 'coyote app',
      domainNames: domain ? [domain.appHost] : undefined,
      certificate: domain?.appCertificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.appBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'AppRewrite', {
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromFile({ filePath: asset('./cf-app-rewrite.js') }),
            }),
          },
        ],
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'AppHeaders', {
          securityHeadersBehavior: {
            contentSecurityPolicy: {
              override: true,
              contentSecurityPolicy: appCsp({
                // Domainless uses wildcards: the exact API and sites URLs would make the two
                // distributions and the API depend on each other in a circle.
                connectSrc: [
                  domain ? domain.urls.apiUrl : `https://*.execute-api.${this.region}.amazonaws.com`,
                  `https://${this.sitesBucket.bucketRegionalDomainName}`, // presigned photo uploads
                ],
                frameSrc: [domain ? domain.urls.previewOrigin : 'https://*.cloudfront.net'],
              }),
            },
            ...commonSecurityHeaders,
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
          },
        }),
      },
    });
    const appUrl = domain ? domain.urls.appUrl : `https://${appDistribution.distributionDomainName}`;

    // ---------------------------------------------------------------------------------------
    // Sites distribution (generated pages, no JS)
    // ---------------------------------------------------------------------------------------
    const rewriteSource = readFileSync(asset('./cf-rewrite.js'), 'utf8')
      .replace('__SITES_HOST__', domain ? domain.sitesHost : '')
      .replace('__APP_URL__', appUrl);

    const sitesDistribution = new cloudfront.Distribution(this, 'SitesDistribution', {
      comment: 'coyote sites',
      domainNames: domain ? [domain.sitesHost, `*.${domain.sitesHost}`] : undefined,
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
              }),
            },
            ...commonSecurityHeaders,
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

    // ---------------------------------------------------------------------------------------
    // API (routes and Lambdas arrive in phase 4)
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
    new apigwv2.HttpStage(this, 'ApiStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      // Global flood protection. The per-IP daily quota lives in the submit Lambda.
      throttle: { rateLimit: 5, burstLimit: 10 },
      domainMapping: domain ? { domainName: domain.apiDomain } : undefined,
    });
    const apiUrl = domain ? domain.urls.apiUrl : this.api.apiEndpoint;

    new s3deploy.BucketDeployment(this, 'AppDeployment', {
      sources: [
        s3deploy.Source.asset(asset('../../web'), { exclude: ['config.js', 'node_modules', '.astro'] }),
        s3deploy.Source.data('config.js', `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl })};\n`),
      ],
      destinationBucket: this.appBucket,
      distribution: appDistribution,
      distributionPaths: ['/*'],
    });

    // ---------------------------------------------------------------------------------------
    // Safety
    // ---------------------------------------------------------------------------------------
    this.guardrail = new CoyoteGuardrail(this, 'Guardrail');
    this.abuseReports = new sns.Topic(this, 'AbuseReports', { displayName: 'Coyote abuse reports' });

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
      alias('SitesApexRecord', domain.sitesZone, domain.sitesHost, new targets.CloudFrontTarget(sitesDistribution));
      alias('SitesWildcardRecord', domain.sitesZone, `*.${domain.sitesHost}`, new targets.CloudFrontTarget(sitesDistribution));
      alias(
        'ApiRecord',
        domain.zone,
        domain.apiHost,
        new targets.ApiGatewayv2DomainProperties(domain.apiDomain.regionalDomainName, domain.apiDomain.regionalHostedZoneId),
      );
    }

    this.urlEnv = domain
      ? { DOMAIN_NAME: props.domainName!, SITES_DOMAIN_NAME: props.sitesDomainName! }
      : { APP_BASE_URL: appUrl, API_BASE_URL: apiUrl, SITES_BASE_URL: sitesBaseUrl };

    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'SitesBaseUrl', { value: domain ? `https://${domain.sitesHost}` : sitesBaseUrl });
    new CfnOutput(this, 'SitesBucketName', { value: this.sitesBucket.bucketName });
    new CfnOutput(this, 'GuardrailId', { value: this.guardrail.guardrailId });
    new CfnOutput(this, 'GuardrailVersion', { value: this.guardrail.version });
  }

  /** Certificates, hosted zones, and hostnames. Needs AWS credentials at synth (hosted-zone lookup). */
  private domainSetup(props: CoyoteStackProps & { domainName: string; sitesDomainName: string }) {
    const urls = createUrls({
      mode: 'domain',
      domainName: props.domainName,
      sitesDomainName: props.sitesDomainName,
    });
    const appHost = new URL(urls.appUrl).host;
    const apiHost = new URL(urls.apiUrl).host;
    const sitesHost = new URL(urls.previewOrigin).host.replace(/^preview\./, '');

    const zoneName = props.hostedZoneName ?? props.domainName;
    const sitesZoneName = props.sitesHostedZoneName ?? props.sitesDomainName;
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName });
    const sitesZone =
      sitesZoneName === zoneName ? zone : route53.HostedZone.fromLookup(this, 'SitesZone', { domainName: sitesZoneName });

    // The stack is in us-east-1, which is where CloudFront needs its certificates.
    const appCertificate = new acm.Certificate(this, 'AppCertificate', {
      domainName: appHost,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const sitesCertificate = new acm.Certificate(this, 'SitesCertificate', {
      domainName: sitesHost,
      subjectAlternativeNames: [`*.${sitesHost}`],
      validation: acm.CertificateValidation.fromDns(sitesZone),
    });
    const apiDomain = new apigwv2.DomainName(this, 'ApiDomain', {
      domainName: apiHost,
      certificate: new acm.Certificate(this, 'ApiCertificate', {
        domainName: apiHost,
        validation: acm.CertificateValidation.fromDns(zone),
      }),
    });

    return { urls, appHost, apiHost, sitesHost, zone, sitesZone, appCertificate, sitesCertificate, apiDomain };
  }
}

const commonSecurityHeaders = {
  strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
  contentTypeOptions: { override: true },
  referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
} satisfies Partial<cloudfront.ResponseSecurityHeadersBehavior>;
