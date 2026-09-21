import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { outputAllowed } from '../core/bedrock';
import { authenticate, deleteSite, ownerView, regenerate, republish, unpublish, updateContent, type OwnerDeps } from '../core/owner';
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
  now: Date.now,
  newId: randomUUID,
};

// GET /me · POST /me/content · POST /me/regenerate · POST /me/unpublish · POST /me/republish · DELETE /me
// POST /jobs/{id}/regenerate ("Genera otra versión" before publishing; the job ID is the credential)
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const route = event.routeKey;

  if (route === 'POST /jobs/{id}/regenerate') {
    const result = await regenerate(await stores.getJob(event.pathParameters?.id ?? ''), deps);
    return json(result.status, result.status === 202 ? result : { error: result.status === 429 ? 'no_regenerations_left' : 'not_available' });
  }

  const site = await authenticate(event.headers.authorization, deps);
  if (site === 'rate_limited') return json(429, { error: 'rate_limited' });
  if (!site) return json(401, { error: 'unauthorized' });

  switch (route) {
    case 'GET /me':
      return json(200, ownerView(site, deps.urls));
    case 'POST /me/content': {
      const result = await updateContent(site, parseBody(event.body, event.isBase64Encoded), deps);
      if (result.status === 200) return json(200, ownerView((await stores.getSite(site.slug))!, deps.urls));
      return json(result.status, result.status === 400 ? { error: 'invalid', fields: result.fields } : { error: result.status === 422 ? 'rejected' : 'not_published' });
    }
    case 'POST /me/regenerate': {
      const result = await regenerate(await stores.getJob(site.jobId), deps);
      return json(result.status, result.status === 202 ? result : { error: result.status === 429 ? 'no_regenerations_left' : 'not_available' });
    }
    case 'POST /me/unpublish':
      await unpublish(site, deps);
      return json(200, { status: 'unpublished' });
    case 'POST /me/republish':
      return json((await republish(site, deps)).status, { status: 'published' });
    case 'DELETE /me':
      await deleteSite(site, deps);
      return json(200, { status: 'deleted' });
    default:
      return json(404, { error: 'not_found' });
  }
};
