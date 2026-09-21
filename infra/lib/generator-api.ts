import { fileURLToPath } from 'node:url';
import {
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  aws_apigatewayv2 as apigwv2,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
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
  guardrail: CoyoteGuardrail;
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
    const submit = fn('Submit', 'submit', {
      environment: {
        ...environment,
        GENERATE_FUNCTION_NAME: generate.functionName,
        RATE_LIMIT_PER_DAY: String(props.rateLimitPerDay),
        // Not a secret: it only keeps raw IPs out of the table. The stack ID is unique per deployment.
        IP_HASH_SALT: Fn.select(2, Fn.split('/', stack.stackId)),
      },
    });
    const status = fn('Status', 'status', { memorySize: 256 });
    const publish = fn('Publish', 'publish');

    // Data access, least privilege per function.
    props.rateLimitTable.grantReadWriteData(submit);
    props.blocklistTable.grantReadData(submit);
    for (const f of [submit, generate, jobFailed, publish]) {
      props.jobsTable.grantReadWriteData(f);
      props.sitesTable.grantReadWriteData(f);
    }
    props.jobsTable.grantReadData(status);
    props.sitesBucket.grantPut(generate, '_preview/*');
    props.sitesBucket.grantRead(publish, '_preview/*');
    props.sitesBucket.grantPut(publish);
    generate.grantInvoke(submit);

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

    const route = (path: string, method: apigwv2.HttpMethod, handler: lambda.IFunction) =>
      props.api.addRoutes({ path, methods: [method], integration: new HttpLambdaIntegration(`${handler.node.id}Integration`, handler) });
    route('/generate', apigwv2.HttpMethod.POST, submit);
    route('/jobs/{id}', apigwv2.HttpMethod.GET, status);
    route('/jobs/{id}/publish', apigwv2.HttpMethod.POST, publish);
  }
}
