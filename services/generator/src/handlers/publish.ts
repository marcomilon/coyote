import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { publish } from '../core/publish';
import { createUrls, urlConfigFromEnv } from '../core/urls';
import { json } from './http';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));

// POST /jobs/{id}/publish
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await publish(event.pathParameters?.id ?? '', { stores, urls });
  if (result.status === 200) return json(200, { siteUrl: result.siteUrl });
  return json(result.status, { error: result.status === 404 ? 'not_found' : 'not_ready' });
};
