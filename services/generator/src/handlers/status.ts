import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { publicJob } from '../core/jobs';
import { json } from './http';

const stores = createStores(storeConfigFromEnv());

// GET /jobs/{id}
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const job = await stores.getJob(event.pathParameters?.id ?? '');
  return job ? json(200, publicJob(job, Date.now())) : json(404, { error: 'not_found' });
};
