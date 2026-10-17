import { fileURLToPath } from 'node:url';
import {
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  aws_apigatewayv2 as apigwv2,
  aws_cloudfront as cloudfront,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
  aws_lambda_event_sources as eventSources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  type aws_ses as ses,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

/** The Anthropic API key for the page writer, created by hand (👤) so it never passes through CDK. */
export const ANTHROPIC_SECRET_NAME = 'coyote/anthropic-api-key';
/**
 * Which model writes the pages: opus or haiku (page-writer.ts `PAGE_MODELS`), set by `./coyote.sh page-model`.
 * CloudFormation writes the value only on create (or when this default changes), so the switch survives deploys.
 */
export const PAGE_MODEL_PARAMETER = '/coyote/page-model';
/** How pages are made: design (Opus writes each page) or template (Haiku fills a template Opus designed). Set by `./coyote.sh page-mode`; survives deploys. */
export const PAGE_MODE_PARAMETER = '/coyote/page-mode';
/** Which skill the page writer gets: a `<name>.md` in the skills bucket, or none. Set by `./coyote.sh page-skill`; survives deploys. */
export const PAGE_SKILL_PARAMETER = '/coyote/page-skill';
/** Whether a new site's request carries the look nudge (page-writer.ts `pickLook`): on or off. Set by `./coyote.sh page-look`; survives deploys. */
export const PAGE_LOOK_PARAMETER = '/coyote/page-look';
/** Whether the page writer may make photos (for owners who left "Fotos creadas con IA" on): on or off. Set by `./coyote.sh page-images`; survives deploys. */
export const PAGE_IMAGES_PARAMETER = '/coyote/page-images';
/** The registrar's API key (`{apikey, secretapikey}`, aws/porkbun.ts), created by hand (👤). */
export const PORKBUN_SECRET_NAME = 'coyote/porkbun-api';
/** Whether owners may register a domain (Coyote pays for now): on or off. Set by `./coyote.sh domain-register`; survives deploys. */
export const DOMAIN_REGISTER_PARAMETER = '/coyote/domain-register';
/** The Cloudflare Turnstile secret key (aws/turnstile.ts), created by hand (👤). */
export const TURNSTILE_SECRET_NAME = 'coyote/turnstile';
/** Paddle's API key and webhook secret (`{apiKey, webhookSecret}`, aws/paddle.ts), created by hand (👤). */
export const PADDLE_SECRET_NAME = 'coyote/paddle';
/** Whether the anonymous forms need the CAPTCHA (Turnstile): on or off. Set by `./coyote.sh captcha`; survives deploys. */
export const CAPTCHA_PARAMETER = '/coyote/captcha';
/** Whether we send email at all: on or off. The bounce/complaint rate alarms turn it off; `./coyote.sh email on` resumes. Survives deploys. */
export const EMAIL_PARAMETER = '/coyote/email';
import { DEFAULT_PAGE_SKILL } from '../../services/generator/src/core/frontend-design';
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from '../../services/generator/src/core/models';
import type { CoyoteGuardrail } from './guardrail';

export interface GeneratorApiProps {
  api: apigwv2.HttpApi;
  jobsTable: dynamodb.ITableV2;
  sitesTable: dynamodb.ITableV2;
  rateLimitTable: dynamodb.ITableV2;
  blocklistTable: dynamodb.ITableV2;
  chatTable: dynamodb.ITableV2;
  accountsTable: dynamodb.ITableV2;
  domainsTable: dynamodb.ITableV2;
  /** Where our emails come from. Unset = no email. */
  mailIdentity?: ses.IEmailIdentity;
  /** The identity's default configuration set; its bounces and complaints go to `mailEvents`. */
  mailConfigurationSet?: ses.IConfigurationSet;
  mailEvents?: sns.ITopic;
  /** Addresses we never email again (core/mail-events.ts). */
  mailSuppressionTable: dynamodb.ITableV2;
  sitesBucket: s3.IBucket;
  /** The page writer's skills, `<name>.md` each (`./coyote.sh page-skill`). */
  pageSkillsBucket: s3.IBucket;
  /** Owner actions invalidate cached drafts. */
  sitesDistribution: cloudfront.IDistribution;
  guardrail: CoyoteGuardrail;
  abuseReports: sns.ITopic;
  siteNotices: sns.ITopic;
  /** Bedrock inference profile or model ID that writes the sites. Also scopes the IAM permission. */
  modelId: string;
  /** Bedrock inference profile or model ID of the pre-screen classifier. */
  prescreenModelId: string;
  rateLimitPerDay: number;
  /** URL env vars from the stack (see urls.ts `urlConfigFromEnv`). */
  urlEnv: Record<string, string>;
  /** The live distribution (coyote-stack.ts): its tenants serve published sites on owners' domains (hosting.ts). */
  live: { distributionId: string; connectionGroupId: string; routingEndpoint: string };
  /** Paddle (design packs, the site's monthly plan). Unset = no checkout routes. */
  paddle?: PaddleConfig;
}

/** CDK context `paddle`: public values only (the client token goes to the browser). */
export interface PaddleConfig {
  env: 'sandbox' | 'production';
  clientToken: string;
  designsPriceId: string;
  /** The monthly plan a site needs before registering a domain. */
  hostingPriceId: string;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const handlers = `${root}services/generator/src/handlers`;

/** The Lambdas behind the HTTP API: submit → (async) generate → status (→ answers → generate) → owner. */
export class GeneratorApi extends Construct {
  readonly generate: lambda.IFunction;
  /** Paid domains whose registration ran out of retries (Paddle config only). */
  readonly domainOrdersDeadLetters?: sqs.IQueue;
  /** Paid domains to register (Paddle config only); `./coyote.sh domain-order` resends to it. */
  readonly domainOrders?: sqs.IQueue;
  /** Registered domains whose site goes live on them; `./coyote.sh hosting` resends to it. */
  readonly hostingSetups: sqs.IQueue;
  readonly hostingSetupsDeadLetters: sqs.IQueue;
  /** SES bounces and complaints → suppression; the reputation alarms → email off. Unset without a sender. */
  readonly mailEvents?: lambda.IFunction;
  /** Every route by its key ("POST /generate"): the stage gives some their own throttle and must wait for them. */
  readonly routes = new Map<string, apigwv2.HttpRoute>();

  constructor(scope: Construct, id: string, props: GeneratorApiProps) {
    super(scope, id);
    const stack = Stack.of(this);

    const environment = {
      JOBS_TABLE: props.jobsTable.tableName,
      SITES_TABLE: props.sitesTable.tableName,
      RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
      BLOCKLIST_TABLE: props.blocklistTable.tableName,
      CHAT_TABLE: props.chatTable.tableName,
      ACCOUNTS_TABLE: props.accountsTable.tableName,
      DOMAINS_TABLE: props.domainsTable.tableName,
      SITES_BUCKET: props.sitesBucket.bucketName,
      BEDROCK_MODEL_ID: props.modelId,
      PRESCREEN_MODEL_ID: props.prescreenModelId,
      GUARDRAIL_ID: props.guardrail.guardrailId,
      GUARDRAIL_VERSION: props.guardrail.version,
      ...props.urlEnv,
    };

    const fn = (name: string, entry: string, options: Partial<nodejs.NodejsFunctionProps> = {}) =>
      new nodejs.NodejsFunction(this, name, {
        entry: `${handlers}/${entry}.ts`,
        projectRoot: root,
        depsLockFilePath: `${root}package-lock.json`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(15),
        environment,
        // Bundle the AWS SDK: the version in the Lambda runtime lags behind the Bedrock API.
        bundling: {
          externalModules: [],
          minify: true,
          sourceMap: false,
        },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...options,
      });

    const jobFailed = fn('JobFailed', 'job-failed', { environment: { ...environment, SITE_NOTICES_TOPIC_ARN: props.siteNotices.topicArn } });
    const pageModel = new ssm.StringParameter(this, 'PageModel', {
      parameterName: PAGE_MODEL_PARAMETER,
      stringValue: 'opus',
      description: 'Page writer model: opus or haiku. Set with ./coyote.sh page-model',
    });
    const pageMode = new ssm.StringParameter(this, 'PageMode', {
      parameterName: PAGE_MODE_PARAMETER,
      stringValue: 'design',
      description: 'How pages are made: design (Opus writes each page) or template (Haiku fills a template). Set with ./coyote.sh page-mode',
    });
    const pageSkill = new ssm.StringParameter(this, 'PageSkill', {
      parameterName: PAGE_SKILL_PARAMETER,
      stringValue: DEFAULT_PAGE_SKILL.name,
      description: 'Page writer skill: a <name>.md in the skills bucket, or none. Set with ./coyote.sh page-skill',
    });
    const pageLook = new ssm.StringParameter(this, 'PageLook', {
      parameterName: PAGE_LOOK_PARAMETER,
      stringValue: 'on',
      description: 'Look nudge on new pages: on or off. Set with ./coyote.sh page-look',
    });
    const pageImages = new ssm.StringParameter(this, 'PageImages', {
      parameterName: PAGE_IMAGES_PARAMETER,
      stringValue: 'on',
      description: 'Photos made by the page writer (when the owner asks): on or off. Set with ./coyote.sh page-images',
    });
    const generate = fn('Generate', 'generate', {
      environment: { ...environment, ANTHROPIC_SECRET_NAME, PAGE_MODE_PARAMETER, PAGE_MODEL_PARAMETER, PAGE_SKILL_PARAMETER, PAGE_LOOK_PARAMETER, PAGE_IMAGES_PARAMETER, IMAGE_MODEL_ID: DEFAULT_IMAGE_MODEL_ID, PAGE_SKILLS_BUCKET: props.pageSkillsBucket.bucketName, SITE_NOTICES_TOPIC_ARN: props.siteNotices.topicArn },
      memorySize: 1024,
      timeout: Duration.minutes(10), // the page writer takes 3–4 minutes
      retryAttempts: 0, // a retry would pay for the model calls twice
      onFailure: new destinations.LambdaDestination(jobFailed),
    });
    this.generate = generate;
    pageMode.grantRead(generate);
    pageModel.grantRead(generate);
    pageSkill.grantRead(generate);
    pageLook.grantRead(generate);
    pageImages.grantRead(generate);
    props.pageSkillsBucket.grantRead(generate);
    // Not a secret: it only keeps raw IPs out of the tables. The stack ID is unique per deployment.
    const ipSalt = Fn.select(2, Fn.split('/', stack.stackId));
    const submit = fn('Submit', 'submit', {
      environment: { ...environment, GENERATE_FUNCTION_NAME: generate.functionName, RATE_LIMIT_PER_DAY: String(props.rateLimitPerDay), IP_HASH_SALT: ipSalt, SITE_NOTICES_TOPIC_ARN: props.siteNotices.topicArn, PAGE_MODE_PARAMETER, PAGE_MODEL_PARAMETER },
    });
    // The free-draft check follows the writer's tier (models.ts), so submit reads the same two switches (aws/page-tier.ts).
    pageMode.grantRead(submit);
    pageModel.grantRead(submit);
    // Takes the magic link off a finished job, so it needs write access to jobs.
    const status = fn('Status', 'status', { memorySize: 256, environment: { ...environment, IP_HASH_SALT: ipSalt } });
    const withInvalidation = { ...environment, SITES_DISTRIBUTION_ID: props.sitesDistribution.distributionId };
    // The chat's replies (chat.ts): Haiku changes the page's text, a new draft. Started by the owner Lambda.
    const chat = fn('Chat', 'chat', {
      // the notice when an account gets frozen (freeze.ts); the page switches for designs left (paid-writes.ts)
      environment: { ...environment, SITE_NOTICES_TOPIC_ARN: props.siteNotices.topicArn, PAGE_MODE_PARAMETER, PAGE_MODEL_PARAMETER },
      memorySize: 1024,
      timeout: Duration.minutes(2),
      retryAttempts: 0, // a retry would pay for the model calls twice; a stuck reply reads as failed
    });
    // Mi sitio and the chat: the draft, contact edits, free-text edits (started here, run by generate), undo, delete, chat messages.
    const owner = fn('Owner', 'owner', { environment: { ...withInvalidation, IP_HASH_SALT: ipSalt, GENERATE_FUNCTION_NAME: generate.functionName, CHAT_FUNCTION_NAME: chat.functionName, PAGE_MODE_PARAMETER, PAGE_MODEL_PARAMETER } });
    // Redesigns left (paid-writes.ts) follow the writer's tier too.
    for (const f of [owner, chat]) {
      pageMode.grantRead(f);
      pageModel.grantRead(f);
    }

    // Data access, least privilege per function. generate and jobFailed: the free draft per email (free-draft.ts);
    // submit, generate and chat: the model calls per email (email-usage.ts).
    for (const f of [submit, generate, jobFailed, chat]) props.rateLimitTable.grantReadWriteData(f);
    props.blocklistTable.grantReadData(submit);
    for (const f of [submit, generate, jobFailed, owner, status]) props.jobsTable.grantReadWriteData(f);
    for (const f of [submit, generate, jobFailed, owner, chat]) props.sitesTable.grantReadWriteData(f);
    for (const f of [owner, chat, generate, jobFailed]) props.chatTable.grantReadWriteData(f);
    // "Mis sitios": sessions reach sites through the owner Lambda; generate links new sites and sends the ready email.
    const account = fn('Account', 'account', { memorySize: 256, environment: { ...environment, IP_HASH_SALT: ipSalt } });
    for (const f of [account, owner, generate]) props.accountsTable.grantReadWriteData(f);
    props.sitesTable.grantReadData(account);
    props.rateLimitTable.grantReadWriteData(account);
    if (props.mailIdentity) {
      // In the SES sandbox the recipients are identities too, so the permission covers every identity of the account.
      // The identity's default configuration set is authorized on the same call.
      const sendEmail = new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          `arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/*`,
          ...(props.mailConfigurationSet ? [`arn:${stack.partition}:ses:${stack.region}:${stack.account}:configuration-set/${props.mailConfigurationSet.configurationSetName}`] : []),
        ],
      });
      const emailSwitch = new ssm.StringParameter(this, 'EmailSwitch', {
        parameterName: EMAIL_PARAMETER,
        stringValue: 'on',
        description: 'Whether we send email: on or off. The bounce and complaint rate alarms turn it off. Set with ./coyote.sh email',
      });
      for (const f of [account, generate]) {
        f.addToRolePolicy(sendEmail);
        f.addEnvironment('EMAIL_PARAMETER', EMAIL_PARAMETER);
        f.addEnvironment('MAIL_SUPPRESSION_TABLE', props.mailSuppressionTable.tableName);
        emailSwitch.grantRead(f);
        props.mailSuppressionTable.grantReadData(f);
      }
      if (props.mailEvents) {
        const mailEvents = fn('MailEvents', 'mail-events', {
          memorySize: 256,
          environment: { EMAIL_PARAMETER, MAIL_SUPPRESSION_TABLE: props.mailSuppressionTable.tableName },
        });
        mailEvents.addEventSource(new eventSources.SnsEventSource(props.mailEvents));
        props.mailSuppressionTable.grantWriteData(mailEvents);
        emailSwitch.grantWrite(mailEvents);
        this.mailEvents = mailEvents;
      }
    }
    // _media/<slug>/: moderated images. _src/<slug>/: sources and site records. _draft/<id>/: served drafts.
    // _live/<slug>/: a published site, which follows every change (drafts.ts refreshPreview); _errors/ gives its 404.
    for (const f of [generate, owner, chat]) props.sitesBucket.grantRead(f, '_errors/*');
    for (const prefix of ['_media/*', '_src/*', '_draft/*', '_live/*']) {
      props.sitesBucket.grantReadWrite(generate, prefix);
      props.sitesBucket.grantDelete(generate, prefix); // old drafts, and a made photo that fails moderation
      props.sitesBucket.grantReadWrite(owner, prefix);
      props.sitesBucket.grantDelete(owner, prefix);
      props.sitesBucket.grantReadWrite(chat, prefix);
      props.sitesBucket.grantDelete(chat, prefix); // drafts beyond the last five
    }
    props.sitesBucket.grantReadWrite(jobFailed, '_media/*'); // frees the images of a new site that never got a draft
    props.sitesBucket.grantDelete(jobFailed, '_media/*');
    generate.grantInvoke(submit);
    generate.grantInvoke(owner);
    chat.grantInvoke(owner);
    const uploads = fn('Uploads', 'uploads', { memorySize: 256, environment: { ...environment, IP_HASH_SALT: ipSalt } });
    props.rateLimitTable.grantReadWriteData(uploads);
    props.sitesBucket.grantPut(uploads, '_uploads/*'); // the presigned POST is signed with this permission
    props.sitesBucket.grantRead(generate, '_uploads/*');
    generate.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels', 'rekognition:DetectText'], resources: ['*'] }));

    // Mi sitio → Dominio (domains.ts): search and register the owner's own domain through the registrar's API.
    const domainRegister = new ssm.StringParameter(this, 'DomainRegister', {
      parameterName: DOMAIN_REGISTER_PARAMETER,
      stringValue: 'off',
      description: 'Owners may register a domain (Coyote pays): on or off. Set with ./coyote.sh domain-register',
    });
    const domains = fn('Domains', 'domains', {
      memorySize: 256,
      timeout: Duration.minutes(1), // a registration is several registrar calls
      environment: { ...environment, IP_HASH_SALT: ipSalt, PORKBUN_SECRET_NAME, DOMAIN_REGISTER_PARAMETER },
    });
    domainRegister.grantRead(domains);
    const porkbunKey = secretsmanager.Secret.fromSecretNameV2(this, 'PorkbunKey', PORKBUN_SECRET_NAME);
    porkbunKey.grantRead(domains);
    props.domainsTable.grantReadWriteData(domains);
    props.sitesTable.grantReadWriteData(domains);
    props.accountsTable.grantReadData(domains); // checkSession, and the email that prefills the form
    props.rateLimitTable.grantReadWriteData(domains);

    // Hosting (hosting.ts): once a domain is registered, its site goes live on it. Each step that has to wait (DNS,
    // the certificate) comes back after the visibility timeout; after 24 tries (about 2 hours) the dead-letter
    // queue alarms.
    const hostingDeadLetters = new sqs.Queue(this, 'HostingSetupsDeadLetters', { retentionPeriod: Duration.days(14), enforceSSL: true });
    const hostingSetups = new sqs.Queue(this, 'HostingSetups', {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: hostingDeadLetters, maxReceiveCount: 24 },
    });
    this.hostingSetupsDeadLetters = hostingDeadLetters;
    this.hostingSetups = hostingSetups;
    hostingSetups.grantSendMessages(domains);
    domains.addEnvironment('HOSTING_SETUPS_QUEUE_URL', hostingSetups.queueUrl);
    const hosting = fn('HostingSetup', 'hosting-setup', {
      memorySize: 256,
      timeout: Duration.minutes(1),
      environment: {
        ...environment,
        PORKBUN_SECRET_NAME,
        LIVE_DISTRIBUTION_ID: props.live.distributionId,
        LIVE_CONNECTION_GROUP_ID: props.live.connectionGroupId,
        LIVE_ROUTING_ENDPOINT: props.live.routingEndpoint,
      },
    });
    porkbunKey.grantRead(hosting);
    props.domainsTable.grantReadWriteData(hosting);
    props.sitesTable.grantReadWriteData(hosting);
    props.sitesBucket.grantRead(hosting, '_draft/*');
    props.sitesBucket.grantRead(hosting, '_errors/*');
    props.sitesBucket.grantReadWrite(hosting, '_live/*');
    props.sitesBucket.grantDelete(hosting, '_live/*');
    hosting.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront:CreateDistributionTenant',
          'cloudfront:GetDistributionTenant',
          'cloudfront:GetDistributionTenantByDomain',
          'cloudfront:UpdateDistributionTenant',
          'cloudfront:DeleteDistributionTenant',
          'cloudfront:GetManagedCertificateDetails',
          'cloudfront:CreateInvalidationForDistributionTenant',
          'cloudfront:GetDistribution',
          'cloudfront:GetConnectionGroup',
          // CloudFront requests and renews the managed certificate in ACM on the caller's behalf.
          'acm:RequestCertificate',
          'acm:DescribeCertificate',
        ],
        resources: ['*'],
      }),
    );
    hosting.addEventSource(new eventSources.SqsEventSource(hostingSetups, { batchSize: 1, reportBatchItemFailures: true }));

    const report = fn('Report', 'report', { environment: { ...withInvalidation, IP_HASH_SALT: ipSalt, ABUSE_TOPIC_ARN: props.abuseReports.topicArn } });

    // The CAPTCHA on the anonymous forms (create, sign-in link, report). Off until the secret exists and a live test passes.
    const captcha = new ssm.StringParameter(this, 'CaptchaSwitch', {
      parameterName: CAPTCHA_PARAMETER,
      stringValue: 'off',
      description: 'CAPTCHA (Cloudflare Turnstile) on the anonymous forms: on or off. Set with ./coyote.sh captcha',
    });
    const turnstileSecret = secretsmanager.Secret.fromSecretNameV2(this, 'TurnstileSecret', TURNSTILE_SECRET_NAME);
    for (const f of [submit, account, report]) {
      f.addEnvironment('CAPTCHA_PARAMETER', CAPTCHA_PARAMETER);
      f.addEnvironment('TURNSTILE_SECRET_NAME', TURNSTILE_SECRET_NAME);
      captcha.grantRead(f);
      turnstileSecret.grantRead(f);
    }
    props.rateLimitTable.grantReadWriteData(report);
    props.sitesTable.grantReadWriteData(report);
    props.sitesBucket.grantReadWrite(report);
    props.sitesBucket.grantDelete(report);
    props.abuseReports.grantPublish(report);
    props.siteNotices.grantPublish(generate);
    props.siteNotices.grantPublish(submit);
    props.siteNotices.grantPublish(chat);
    props.siteNotices.grantPublish(jobFailed); // the failure notice of a crashed or timed-out generate
    for (const f of [owner, report]) props.sitesDistribution.grantCreateInvalidation(f);
    // Every API Lambda counts requests per IP per minute (perIpLimit in handlers/http.ts).
    for (const f of [owner, status]) props.rateLimitTable.grantReadWriteData(f);

    // Bedrock: text model calls are only allowed with our guardrail attached.
    const modelResources = (modelId: string) => [
      `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
      `arn:${stack.partition}:bedrock:*::foundation-model/${modelId.replace(/^(us|eu|apac|global)\./, '')}`,
    ];
    const guarded = { StringLike: { 'bedrock:GuardrailIdentifier': [props.guardrail.guardrailArn, `${props.guardrail.guardrailArn}:*`] } };
    const invokePrescreen = new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: modelResources(props.prescreenModelId), conditions: guarded });
    const invokeWriter = new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: modelResources(props.modelId), conditions: guarded });
    const applyGuardrail = new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [
        props.guardrail.guardrailArn,
        // The Standard tier runs through a cross-region guardrail profile.
        `arn:${stack.partition}:bedrock:*:${stack.account}:guardrail-profile/*`,
      ],
    });
    for (const f of [submit, generate, chat]) {
      f.addToRolePolicy(invokePrescreen);
      f.addToRolePolicy(applyGuardrail);
    }
    for (const f of [generate, chat]) f.addToRolePolicy(invokeWriter);
    // The image model (us-west-2: us-east-1 has no text-to-image model) takes no guardrail: the scene goes through
    // ApplyGuardrail first and the photo through Rekognition (images.ts).
    generate.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [`arn:${stack.partition}:bedrock:${IMAGE_MODEL_REGION}::foundation-model/${DEFAULT_IMAGE_MODEL_ID}`] }),
    );
    secretsmanager.Secret.fromSecretNameV2(this, 'AnthropicKey', ANTHROPIC_SECRET_NAME).grantRead(generate);
    owner.addToRolePolicy(applyGuardrail); // an edited address is checked by the guardrail; the owner Lambda never calls a model

    const route = (path: string, method: apigwv2.HttpMethod, handler: lambda.IFunction) => {
      const [added] = props.api.addRoutes({ path, methods: [method], integration: new HttpLambdaIntegration(`${handler.node.id}Integration`, handler) });
      this.routes.set(`${method} ${path}`, added!);
    };
    route('/generate', apigwv2.HttpMethod.POST, submit);
    route('/jobs/{id}', apigwv2.HttpMethod.GET, status);
    route('/jobs/{id}/answers', apigwv2.HttpMethod.POST, submit);
    route('/report/{slug}', apigwv2.HttpMethod.POST, report);
    route('/uploads', apigwv2.HttpMethod.POST, uploads);
    route('/me', apigwv2.HttpMethod.GET, owner);
    route('/me', apigwv2.HttpMethod.DELETE, owner);
    for (const action of ['edit', 'undo', 'chat', 'design']) route(`/me/${action}`, apigwv2.HttpMethod.POST, owner);
    route('/me/chat', apigwv2.HttpMethod.GET, owner);
    for (const action of ['login', 'session']) route(`/account/${action}`, apigwv2.HttpMethod.POST, account);
    route('/account', apigwv2.HttpMethod.GET, account);
    route('/me/domain', apigwv2.HttpMethod.GET, domains);
    route('/me/domain', apigwv2.HttpMethod.POST, domains);
    route('/me/domain/check', apigwv2.HttpMethod.GET, domains);

    // Design packs and the monthly plan (payments.ts): a checkout and the plan's portal for Mi sitio, and Paddle's
    // webhook that adds the designs once paid and writes the plan onto the site.
    if (props.paddle) {
      const payments = fn('Payments', 'payments', {
        memorySize: 256,
        environment: { ...environment, IP_HASH_SALT: ipSalt, PADDLE_SECRET_NAME, PADDLE_ENV: props.paddle.env, PADDLE_DESIGNS_PRICE_ID: props.paddle.designsPriceId, PADDLE_HOSTING_PRICE_ID: props.paddle.hostingPriceId, PAGE_MODE_PARAMETER, PAGE_MODEL_PARAMETER, PORKBUN_SECRET_NAME },
      });
      secretsmanager.Secret.fromSecretNameV2(this, 'PaddleKey', PADDLE_SECRET_NAME).grantRead(payments);
      porkbunKey.grantRead(payments); // the plan's domain is still free before its checkout

      // The domain a paid plan ordered: the webhook queues it, DomainOrder registers it. A failed try comes back
      // after the visibility timeout; after 6 (about an hour) it goes to the dead-letter queue, which alarms.
      const deadLetters = new sqs.Queue(this, 'DomainOrdersDeadLetters', { retentionPeriod: Duration.days(14), enforceSSL: true });
      const orders = new sqs.Queue(this, 'DomainOrders', {
        visibilityTimeout: Duration.minutes(10),
        retentionPeriod: Duration.days(4),
        enforceSSL: true,
        deadLetterQueue: { queue: deadLetters, maxReceiveCount: 6 },
      });
      this.domainOrdersDeadLetters = deadLetters;
      this.domainOrders = orders;
      orders.grantSendMessages(payments);
      payments.addEnvironment('DOMAIN_ORDERS_QUEUE_URL', orders.queueUrl);
      const domainOrder = fn('DomainOrder', 'domain-order', {
        memorySize: 256,
        timeout: Duration.minutes(1),
        environment: { ...environment, IP_HASH_SALT: ipSalt, PORKBUN_SECRET_NAME, DOMAIN_REGISTER_PARAMETER },
      });
      domainRegister.grantRead(domainOrder);
      porkbunKey.grantRead(domainOrder);
      props.domainsTable.grantReadWriteData(domainOrder);
      props.sitesTable.grantReadWriteData(domainOrder);
      props.accountsTable.grantReadData(domainOrder); // the owner's email on the domain record
      props.rateLimitTable.grantReadWriteData(domainOrder);
      domainOrder.addEventSource(new eventSources.SqsEventSource(orders, { batchSize: 1, reportBatchItemFailures: true }));
      hostingSetups.grantSendMessages(domainOrder);
      domainOrder.addEnvironment('HOSTING_SETUPS_QUEUE_URL', hostingSetups.queueUrl);
      // Paying publishes: a plan that ends takes the live copy down, paying again puts it back (payments.ts).
      props.domainsTable.grantReadData(payments);
      props.sitesBucket.grantRead(payments, '_draft/*');
      props.sitesBucket.grantRead(payments, '_errors/*');
      props.sitesBucket.grantReadWrite(payments, '_live/*');
      props.sitesBucket.grantDelete(payments, '_live/*');
      pageMode.grantRead(payments);
      pageModel.grantRead(payments);
      props.sitesTable.grantReadWriteData(payments); // the plan (billing) on the site
      props.accountsTable.grantReadData(payments); // checkSession, and the email that prefills the checkout
      props.rateLimitTable.grantReadWriteData(payments);
      route('/me/checkout', apigwv2.HttpMethod.POST, payments);
      route('/me/billing/portal', apigwv2.HttpMethod.POST, payments);
      route('/paddle/webhook', apigwv2.HttpMethod.POST, payments);
    }
  }
}
