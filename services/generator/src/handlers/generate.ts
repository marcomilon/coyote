import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { runGenerateJob } from '../core/generate-job';
import { modelId } from '../core/models';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));

// Invoked asynchronously by submit with { jobId }.
export const handler = async (event: { jobId: string }): Promise<void> => {
  await runGenerateJob(event.jobId, { stores, callTool, modelId: modelId(), urls, outputAllowed });
};
