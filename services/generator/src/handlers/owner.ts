import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { outputAllowed } from '../core/bedrock';
import { emitMetrics } from '../core/metrics';
import { chatView, postChat } from '../core/chat';
import { authenticate, deleteSite, editSite, ownerView, POLL_CAP, undo, type OwnerDeps } from '../core/owner';
import { createUrls, urlConfigFromEnv } from '../core/urls';
import { json, parseBody } from './http';

const stores = createStores(storeConfigFromEnv());
const lambda = new LambdaClient({});
const deps: OwnerDeps = {
  stores,
  urls: createUrls(urlConfigFromEnv(process.env)),
  outputAllowed,
  startGenerate: async (jobId) => {
    await lambda.send(new InvokeCommand({ FunctionName: process.env.GENERATE_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ jobId })) }));
  },
  startChat: async (slug, at) => {
    await lambda.send(new InvokeCommand({ FunctionName: process.env.CHAT_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ slug, at })) }));
  },
  now: Date.now,
  newId: randomUUID,
};

const ERRORS: Record<number, string> = { 400: 'invalid', 409: 'not_available', 422: 'rejected', 429: 'rate_limited' };

// GET /me · POST /me/edit · POST /me/undo · DELETE /me · GET /me/chat · POST /me/chat. The magic-link token is the credential.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const polling = event.routeKey === 'GET /me/chat';
  const site = await authenticate(event.headers.authorization, deps, polling ? POLL_CAP : undefined);
  if (site === 'rate_limited') return json(429, { error: 'rate_limited' });
  if (!site) return json(401, { error: 'unauthorized' });

  switch (event.routeKey) {
    case 'GET /me':
      return json(200, await ownerView(site, deps));
    case 'POST /me/edit': {
      const result = await editSite(site, parseBody(event.body, event.isBase64Encoded), deps);
      if (result.status === 202) {
        emitMetrics({ Edited: 1 });
        return json(202, { jobId: result.jobId });
      }
      if (result.status === 200) return json(200, await ownerView((await stores.getSite(site.slug))!, deps));
      return json(result.status, { error: ERRORS[result.status], ...(result.status === 400 ? { fields: result.fields } : {}) });
    }
    case 'POST /me/undo': {
      const result = await undo(site, deps);
      return result.status === 200 ? json(200, await ownerView((await stores.getSite(site.slug))!, deps)) : json(409, { error: 'nothing_to_undo' });
    }
    case 'GET /me/chat': {
      const after = Number(event.queryStringParameters?.after);
      return json(200, await chatView(site, Number.isFinite(after) && after > 0 ? after : undefined, deps));
    }
    case 'POST /me/chat': {
      const result = await postChat(site, parseBody(event.body, event.isBase64Encoded), deps);
      if (result.status === 202) return json(202, { messages: result.messages });
      return json(result.status, { error: result.status === 409 ? result.error : ERRORS[result.status] });
    }
    case 'DELETE /me':
      await deleteSite(site, deps);
      return json(200, { status: 'deleted' });
    default:
      return json(404, { error: 'not_found' });
  }
};
