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
  aws_sns as sns,
} from 'aws-cdk-lib';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import type { CoyoteGuardrail } from './guardrail';

export interface GeneratorApiProps {
  api: apigwv2.HttpApi;
  jobsTable: dynamodb.ITableV2;
  sitesTable: dynamodb.ITableV2;
  rateLimitTable: dynamodb.ITableV2;
  blocklistTable: dynamodb.ITableV2;
  sitesBucket: s3.IBucket;
  /** Owner actions and publishing invalidate the cached site. */
  sitesDistribution: cloudfront.IDistribution;
  guardrail: CoyoteGuardrail;
  abuseReports: sns.ITopic;
  /** Bedrock inference profile or model ID. Also scopes the IAM permission. */
  modelId: string;
  rateLimitPerDay: number;
  /** URL env vars from the stack (see urls.ts `urlConfigFromEnv`). */
  urlEnv: Record<string, string>;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const handlers = `${root}services/generator/src/handlers`;

/** The Lambdas behind the HTTP API: submit → (async) generate → status → publish. */
export class GeneratorApi extends Construct {
  readonly generate: lambda.IFunction;

  constructor(scope: Construct, id: string, props: GeneratorApiProps) {
    super(scope, id);
    const stack = Stack.of(this);

    const environment = {
      JOBS_TABLE: props.jobsTable.tableName,
      SITES_TABLE: props.sitesTable.tableName,
      RATE_LIMIT_TABLE: props.rateLimitTable.tableName,
      BLOCKLIST_TABLE: props.blocklistTable.tableName,
      SITES_BUCKET: props.sitesBucket.bucketName,
      BEDROCK_MODEL_ID: props.modelId,
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
      memorySize: 1024,
      timeout: Duration.minutes(5),
      retryAttempts: 0, // a retry would pay for the model calls twice
      onFailure: new destinations.LambdaDestination(jobFailed),
    });
    this.generate = generate;
    // Not a secret: it only keeps raw IPs out of the tables. The stack ID is unique per deployment.
    const ipSalt = Fn.select(2, Fn.split('/', stack.stackId));
    const submit = fn('Submit', 'submit', {
      environment: { ...environment, GENERATE_FUNCTION_NAME: generate.functionName, RATE_LIMIT_PER_DAY: String(props.rateLimitPerDay), IP_HASH_SALT: ipSalt },
    });
    const status = fn('Status', 'status', { memorySize: 256 });
    const withInvalidation = { ...environment, SITES_DISTRIBUTION_ID: props.sitesDistribution.distributionId };
    const publish = fn('Publish', 'publish', { environment: withInvalidation });
    // Everything an owner does after publishing, plus "another version" before publishing.
    const owner = fn('Owner', 'owner', { environment: { ...withInvalidation, GENERATE_FUNCTION_NAME: generate.functionName } });

    // Data access, least privilege per function.
    props.rateLimitTable.grantReadWriteData(submit);
    props.blocklistTable.grantReadData(submit);
    for (const f of [submit, generate, jobFailed, publish, owner]) {
      props.jobsTable.grantReadWriteData(f);
      props.sitesTable.grantReadWriteData(f);
    }
    props.jobsTable.grantReadData(status);
    props.sitesBucket.grantPut(generate, '_preview/*');
    props.sitesBucket.grantRead(publish, '_preview/*');
    props.sitesBucket.grantPut(publish);
    generate.grantInvoke(submit);
    generate.grantInvoke(owner);
    const report = fn('Report', 'report', { environment: { ...withInvalidation, IP_HASH_SALT: ipSalt, ABUSE_TOPIC_ARN: props.abuseReports.topicArn } });
    props.rateLimitTable.grantReadWriteData(report);
    props.sitesTable.grantReadWriteData(report);
    props.sitesBucket.grantReadWrite(report);
    props.sitesBucket.grantDelete(report);
    props.abuseReports.grantPublish(report);
    for (const f of [publish, owner, report]) props.sitesDistribution.grantCreateInvalidation(f);
    props.rateLimitTable.grantReadWriteData(owner);
    props.sitesBucket.grantPut(owner);
    props.sitesBucket.grantRead(owner);
    props.sitesBucket.grantDelete(owner);

    // Bedrock: model calls are only allowed with our guardrail attached.
    const foundationModel = props.modelId.replace(/^(us|eu|apac|global)\./, '');
    const invokeModel = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${props.modelId}`,
        `arn:${stack.partition}:bedrock:*::foundation-model/${foundationModel}`,
      ],
      conditions: {
        StringLike: { 'bedrock:GuardrailIdentifier': [props.guardrail.guardrailArn, `${props.guardrail.guardrailArn}:*`] },
      },
    });
    const applyGuardrail = new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [
        props.guardrail.guardrailArn,
        // The Standard tier runs through a cross-region guardrail profile.
        `arn:${stack.partition}:bedrock:*:${stack.account}:guardrail-profile/*`,
      ],
    });
    for (const f of [submit, generate]) {
      f.addToRolePolicy(invokeModel);
      f.addToRolePolicy(applyGuardrail);
    }
    owner.addToRolePolicy(applyGuardrail); // edits are checked by the guardrail; the owner Lambda never calls a model

    const route = (path: string, method: apigwv2.HttpMethod, handler: lambda.IFunction) =>
      props.api.addRoutes({ path, methods: [method], integration: new HttpLambdaIntegration(`${handler.node.id}Integration`, handler) });
    route('/generate', apigwv2.HttpMethod.POST, submit);
    route('/jobs/{id}', apigwv2.HttpMethod.GET, status);
    route('/jobs/{id}/publish', apigwv2.HttpMethod.POST, publish);
    route('/report/{slug}', apigwv2.HttpMethod.POST, report);
    route('/jobs/{id}/regenerate', apigwv2.HttpMethod.POST, owner);
    route('/me', apigwv2.HttpMethod.GET, owner);
    route('/me', apigwv2.HttpMethod.DELETE, owner);
    for (const action of ['content', 'regenerate', 'unpublish', 'republish']) route(`/me/${action}`, apigwv2.HttpMethod.POST, owner);
  }
}
