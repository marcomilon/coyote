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
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  type aws_ses as ses,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

/** The Anthropic API key for the page writer, created by hand (👤) so it never passes through CDK. */
export const ANTHROPIC_SECRET_NAME = 'coyote/anthropic-api-key';
import type { CoyoteGuardrail } from './guardrail';

export interface GeneratorApiProps {
  api: apigwv2.HttpApi;
  jobsTable: dynamodb.ITableV2;
  sitesTable: dynamodb.ITableV2;
  rateLimitTable: dynamodb.ITableV2;
  blocklistTable: dynamodb.ITableV2;
  chatTable: dynamodb.ITableV2;
  accountsTable: dynamodb.ITableV2;
  /** Where our emails come from. Unset = no email. */
  mailIdentity?: ses.IEmailIdentity;
  sitesBucket: s3.IBucket;
  /** Owner actions invalidate cached drafts. */
  sitesDistribution: cloudfront.IDistribution;
  guardrail: CoyoteGuardrail;
  abuseReports: sns.ITopic;
  /** Bedrock inference profile or model ID that writes the sites. Also scopes the IAM permission. */
  modelId: string;
  /** Bedrock inference profile or model ID of the pre-screen classifier. */
  prescreenModelId: string;
  rateLimitPerDay: number;
  /** URL env vars from the stack (see urls.ts `urlConfigFromEnv`). */
  urlEnv: Record<string, string>;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const handlers = `${root}services/generator/src/handlers`;

/** The Lambdas behind the HTTP API: submit → (async) generate → status (→ answers → generate) → owner. */
export class GeneratorApi extends Construct {
  readonly generate: lambda.IFunction;
  /** GET /me/chat, which the stage gives its own throttle (the stage must wait for it). */
  readonly chatPollRoute: apigwv2.HttpRoute;

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
          // css-tree's ESM entry loads its data with createRequire(import.meta.url), which is undefined in a
          // CommonJS bundle. Its dist build is self-contained.
          esbuildArgs: { '--alias:css-tree': 'css-tree/dist/csstree.esm' },
        },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...options,
      });

    const jobFailed = fn('JobFailed', 'job-failed');
    const generate = fn('Generate', 'generate', {
      environment: { ...environment, ANTHROPIC_SECRET_NAME },
      memorySize: 1024,
      timeout: Duration.minutes(10), // the page writer takes 3–4 minutes
      retryAttempts: 0, // a retry would pay for the model calls twice
      onFailure: new destinations.LambdaDestination(jobFailed),
    });
    this.generate = generate;
    // Not a secret: it only keeps raw IPs out of the tables. The stack ID is unique per deployment.
    const ipSalt = Fn.select(2, Fn.split('/', stack.stackId));
    const submit = fn('Submit', 'submit', {
      environment: { ...environment, GENERATE_FUNCTION_NAME: generate.functionName, RATE_LIMIT_PER_DAY: String(props.rateLimitPerDay), IP_HASH_SALT: ipSalt },
    });
    // Takes the magic link off a finished job, so it needs write access to jobs.
    const status = fn('Status', 'status', { memorySize: 256 });
    const withInvalidation = { ...environment, SITES_DISTRIBUTION_ID: props.sitesDistribution.distributionId };
    // The chat's replies (chat.ts): Haiku changes the page's text, a new draft. Started by the owner Lambda.
    const chat = fn('Chat', 'chat', {
      memorySize: 1024,
      timeout: Duration.minutes(2),
      retryAttempts: 0, // a retry would pay for the model calls twice; a stuck reply reads as failed
    });
    // Mi sitio and the chat: the draft, contact edits, free-text edits (started here, run by generate), undo, delete, chat messages.
    const owner = fn('Owner', 'owner', { environment: { ...withInvalidation, GENERATE_FUNCTION_NAME: generate.functionName, CHAT_FUNCTION_NAME: chat.functionName } });

    // Data access, least privilege per function.
    props.rateLimitTable.grantReadWriteData(submit);
    props.blocklistTable.grantReadData(submit);
    for (const f of [submit, generate, jobFailed, owner, status]) props.jobsTable.grantReadWriteData(f);
    for (const f of [submit, generate, jobFailed, owner, chat]) props.sitesTable.grantReadWriteData(f);
    for (const f of [owner, chat]) props.chatTable.grantReadWriteData(f);
    // "Mis sitios": sessions reach sites through the owner Lambda; generate links new sites and sends the ready email.
    const account = fn('Account', 'account', { memorySize: 256, environment: { ...environment, IP_HASH_SALT: ipSalt } });
    for (const f of [account, owner, generate]) props.accountsTable.grantReadWriteData(f);
    props.sitesTable.grantReadData(account);
    props.rateLimitTable.grantReadWriteData(account);
    if (props.mailIdentity) {
      // In the SES sandbox the recipients are identities too, so the permission covers every identity of the account.
      const sendEmail = new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: [`arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/*`] });
      for (const f of [account, generate]) f.addToRolePolicy(sendEmail);
    }
    // _media/<slug>/: moderated images. _src/<slug>/: sources and site records. _draft/<id>/: served drafts.
    for (const prefix of ['_media/*', '_src/*', '_draft/*']) {
      props.sitesBucket.grantReadWrite(generate, prefix);
      props.sitesBucket.grantDelete(generate, prefix); // old drafts, and a hero photo that fails moderation
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
    generate.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels'], resources: ['*'] }));

    const report = fn('Report', 'report', { environment: { ...withInvalidation, IP_HASH_SALT: ipSalt, ABUSE_TOPIC_ARN: props.abuseReports.topicArn } });
    props.rateLimitTable.grantReadWriteData(report);
    props.sitesTable.grantReadWriteData(report);
    props.sitesBucket.grantReadWrite(report);
    props.sitesBucket.grantDelete(report);
    props.abuseReports.grantPublish(report);
    for (const f of [owner, report]) props.sitesDistribution.grantCreateInvalidation(f);
    props.rateLimitTable.grantReadWriteData(owner);

    // Bedrock: model calls are only allowed with our guardrail attached.
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
    secretsmanager.Secret.fromSecretNameV2(this, 'AnthropicKey', ANTHROPIC_SECRET_NAME).grantRead(generate);
    owner.addToRolePolicy(applyGuardrail); // an edited address is checked by the guardrail; the owner Lambda never calls a model

    const route = (path: string, method: apigwv2.HttpMethod, handler: lambda.IFunction) =>
      props.api.addRoutes({ path, methods: [method], integration: new HttpLambdaIntegration(`${handler.node.id}Integration`, handler) });
    route('/generate', apigwv2.HttpMethod.POST, submit);
    route('/jobs/{id}', apigwv2.HttpMethod.GET, status);
    route('/jobs/{id}/answers', apigwv2.HttpMethod.POST, submit);
    route('/report/{slug}', apigwv2.HttpMethod.POST, report);
    route('/uploads', apigwv2.HttpMethod.POST, uploads);
    route('/me', apigwv2.HttpMethod.GET, owner);
    route('/me', apigwv2.HttpMethod.DELETE, owner);
    for (const action of ['edit', 'undo', 'chat']) route(`/me/${action}`, apigwv2.HttpMethod.POST, owner);
    this.chatPollRoute = route('/me/chat', apigwv2.HttpMethod.GET, owner)[0]!;
    for (const action of ['login', 'session']) route(`/account/${action}`, apigwv2.HttpMethod.POST, account);
    route('/account', apigwv2.HttpMethod.GET, account);
  }
}
