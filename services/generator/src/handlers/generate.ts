import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { runGenerateJob } from '../core/generate-job';
import { emitMetrics } from '../core/metrics';
import { modelId } from '../core/models';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));

// Invoked asynchronously by submit with { jobId }.
export const handler = async (event: { jobId: string }): Promise<void> => {
  const result = await runGenerateJob(event.jobId, { stores, callTool, modelId: modelId(), urls, outputAllowed });
  if (result.outcome === 'SKIPPED') return;
  const name = result.outcome === 'DONE' ? 'Generated' : result.outcome === 'REJECTED' ? 'Rejected' : 'Failed';
  emitMetrics({ [name]: 1, TokensIn: result.tokensIn, TokensOut: result.tokensOut });
};
