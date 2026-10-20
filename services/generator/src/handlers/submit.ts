import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { snsAnnounce } from '../aws/notices';
import { pageTier } from '../aws/page-tier';
import { turnstile } from '../aws/turnstile';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { submitAnswers } from '../core/clarify';
import { describe } from '../core/describe';
import { emitMetrics } from '../core/metrics';
import { modelId, prescreenModelId } from '../core/models';
import { submit } from '../core/submit';
import { json, parseBody, perIpLimit } from './http';

const stores = createStores(storeConfigFromEnv());
const lambda = new LambdaClient({});
const announce = snsAnnounce(process.env.SITE_NOTICES_TOPIC_ARN);
const verifyHuman = turnstile();
const startGenerate = async (jobId: string) => {
  await lambda.send(new InvokeCommand({ FunctionName: process.env.GENERATE_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ jobId })) }));
};

// POST /generate · POST /jobs/{id}/answers (the owner's answers to the model's questions; the job ID is the credential)
// · POST /describe ("Mejorar mi descripción": the cheap model rewrites the form's description)
export const handler: APIGatewayProxyHandlerV2 = perIpLimit(stores, async (event) => {
  const body = parseBody(event.body, event.isBase64Encoded);

  if (event.routeKey === 'POST /describe') {
    const result = await describe(body, event.requestContext.http.sourceIp, {
      stores,
      callTool,
      modelId: modelId(),
      ipSalt: process.env.IP_HASH_SALT ?? '',
      verifyHuman,
      outputAllowed: (text) => outputAllowed(text),
      now: Date.now,
    });
    if ('usage' in result) emitMetrics({ Described: 1, TokensIn: result.usage.reduce((n, u) => n + u.inputTokens, 0), TokensOut: result.usage.reduce((n, u) => n + u.outputTokens, 0) });
    switch (result.status) {
      case 200:
        return json(200, { about: result.about, missing: result.missing });
      case 400:
        return json(400, { error: 'invalid', fields: ['about'] });
      case 403:
        return json(403, { error: 'captcha' });
      case 422:
        return json(422, { error: result.unclear ? 'unclear' : 'rejected' }); // never say why
      case 429:
        return json(429, { error: 'rate_limited' });
      case 502:
        return json(502, { error: 'failed' });
    }
  }

  if (event.routeKey === 'POST /jobs/{id}/answers') {
    const result = await submitAnswers(event.pathParameters?.id ?? '', body, { stores, callTool, prescreenModelId: prescreenModelId(), startGenerate, now: Date.now, announce });
    if (result.status === 422) emitMetrics({ Rejected: 1 });
    switch (result.status) {
      case 202:
        return json(202, { status: 'PENDING' });
      case 400:
        return json(400, { error: result.required ? 'required' : 'invalid', fields: result.fields });
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
    verifyHuman,
    pageTier: () => pageTier(),
    now: Date.now,
    newId: randomUUID,
  });

  if (result.status !== 400) {
    const metric =
      result.status === 202 ? 'Submitted' : result.status === 429 ? 'RateLimited' : result.status === 403 ? 'CaptchaFailed' : result.status === 409 ? 'HasDraft' : result.status === 423 ? 'Frozen' : result.unclear ? 'Unclear' : 'Rejected';
    emitMetrics({ [metric]: 1 });
  }

  switch (result.status) {
    case 202:
      return json(202, { jobId: result.jobId });
    case 400:
      return json(400, { error: 'invalid', fields: result.fields });
    case 403:
      return json(403, { error: 'captcha' });
    case 409:
      return json(409, { error: 'has_draft' });
    case 422:
      // A policy rejection never says why; an unclear description asks the owner to describe the business again.
      return json(422, { error: result.unclear ? 'unclear' : 'rejected' });
    case 423:
      return json(423, { error: 'frozen' });
    case 429:
      return json(429, { error: 'rate_limited' });
  }
});
