import { createStores, storeConfigFromEnv } from '../aws/stores';
import { releaseNewSite } from '../core/generate-job';

const stores = createStores(storeConfigFromEnv());

interface FailureEvent {
  requestPayload?: { jobId?: string };
  responsePayload?: { errorMessage?: string };
}

// On-failure destination of generate: a timeout or crash that runGenerateJob could not record itself.
export const handler = async (event: FailureEvent): Promise<void> => {
  const jobId = event.requestPayload?.jobId;
  if (!jobId) return;
  const job = await stores.getJob(jobId);
  if (!job || job.status !== 'PENDING') return;
  await releaseNewSite(job, { stores });
  await stores.updateJob(jobId, { status: 'FAILED', error: (event.responsePayload?.errorMessage ?? 'generate crashed').slice(0, 500) });
};
