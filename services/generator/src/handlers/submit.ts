import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool } from '../core/bedrock';
import { modelId } from '../core/models';
import { submit } from '../core/submit';
import { json, parseBody } from './http';

const stores = createStores(storeConfigFromEnv());
const lambda = new LambdaClient({});

// POST /generate
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await submit(parseBody(event.body, event.isBase64Encoded), event.requestContext.http.sourceIp, {
    stores,
    callTool,
    modelId: modelId(),
    rateLimitPerDay: Number(process.env.RATE_LIMIT_PER_DAY ?? 3),
    ipSalt: process.env.IP_HASH_SALT ?? '',
    startGenerate: async (jobId) => {
      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.GENERATE_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ jobId })),
        }),
      );
    },
    now: Date.now,
    newId: randomUUID,
  });

  switch (result.status) {
    case 202:
      return json(202, { jobId: result.jobId });
    case 400:
      return json(400, { error: 'invalid', fields: result.fields });
    case 422:
      return json(422, { error: 'rejected' }); // never say why
    case 429:
      return json(429, { error: 'rate_limited' });
  }
};
