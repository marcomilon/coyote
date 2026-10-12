import { snsAnnounce } from '../aws/notices';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { recordGenerateCrash } from '../core/generate-job';

const stores = createStores(storeConfigFromEnv());
const announce = snsAnnounce(process.env.SITE_NOTICES_TOPIC_ARN);

interface FailureEvent {
  requestPayload?: { jobId?: string };
  responsePayload?: { errorMessage?: string };
}

// On-failure destination of generate: a timeout or crash that runGenerateJob could not record itself.
export const handler = async (event: FailureEvent): Promise<void> => {
  const jobId = event.requestPayload?.jobId;
  if (!jobId) return;
  await recordGenerateCrash(jobId, event.responsePayload?.errorMessage, { stores, announce });
};
