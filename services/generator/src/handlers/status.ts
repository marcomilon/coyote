import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { publicJob } from '../core/jobs';
import { createUrls, urlConfigFromEnv } from '../core/urls';
import { json } from './http';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));

// GET /jobs/{id}. The job ID is the credential.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const job = await stores.getJob(event.pathParameters?.id ?? '');
  if (!job) return json(404, { error: 'not_found' });
  // A new site's magic link is handed out once, to the first read after DONE, and then removed from the job.
  const token = job.status === 'DONE' && job.ownerToken ? await stores.takeOwnerToken(job.jobId) : undefined;
  return json(200, { ...publicJob(job, Date.now()), ...(token ? { miSitioUrl: urls.miSitioUrl(token), ownerWhatsApp: job.answers.contact.whatsapp } : {}) });
};
