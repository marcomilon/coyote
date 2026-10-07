import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { snsAnnounce } from '../aws/notices';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool } from '../core/bedrock';
import { submitAnswers } from '../core/clarify';
import { emitMetrics } from '../core/metrics';
import { prescreenModelId } from '../core/models';
import { submit } from '../core/submit';
import { json, parseBody } from './http';

const stores = createStores(storeConfigFromEnv());
const lambda = new LambdaClient({});
const announce = snsAnnounce(process.env.SITE_NOTICES_TOPIC_ARN);
const startGenerate = async (jobId: string) => {
  await lambda.send(new InvokeCommand({ FunctionName: process.env.GENERATE_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ jobId })) }));
};

// POST /generate · POST /jobs/{id}/answers (the owner's answers to the model's questions; the job ID is the credential)
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = parseBody(event.body, event.isBase64Encoded);

  if (event.routeKey === 'POST /jobs/{id}/answers') {
    const result = await submitAnswers(event.pathParameters?.id ?? '', body, { stores, callTool, prescreenModelId: prescreenModelId(), startGenerate, now: Date.now, announce });
    if (result.status === 422) emitMetrics({ Rejected: 1 });
    switch (result.status) {
      case 202:
        return json(202, { status: 'PENDING' });
      case 400:
        return json(400, { error: 'invalid', fields: result.fields });
      case 422:
        return json(422, { error: 'rejected' }); // never say why
      default:
        return json(result.status, { error: result.status === 404 ? 'not_found' : 'not_waiting' });
    }
  }

  const result = await submit(body, event.requestContext.http.sourceIp, {
    stores,
    callTool,
    modelId: prescreenModelId(),
    rateLimitPerDay: Number(process.env.RATE_LIMIT_PER_DAY ?? 3),
    ipSalt: process.env.IP_HASH_SALT ?? '',
    startGenerate,
    announce,
    now: Date.now,
    newId: randomUUID,
  });

  if (result.status !== 400) emitMetrics({ [result.status === 202 ? 'Submitted' : result.status === 429 ? 'RateLimited' : 'Rejected']: 1 });

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
