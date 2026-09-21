import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { runGenerateJob } from '../core/generate-job';
import { emitMetrics } from '../core/metrics';
import { modelId } from '../core/models';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));
const rekognition = new RekognitionClient({});

/** Top-level moderation categories we refuse. Alcohol and swimwear are fine: restaurants and beachwear shops exist. */
const REFUSED = new Set(['Explicit', 'Non-Explicit Nudity of Intimate parts and Kissing', 'Violence', 'Visually Disturbing', 'Hate Symbols', 'Drugs & Tobacco', 'Gambling']);

async function moderate(key: string): Promise<string[]> {
  const { ModerationLabels } = await rekognition.send(
    new DetectModerationLabelsCommand({ Image: { S3Object: { Bucket: process.env.SITES_BUCKET, Name: key } }, MinConfidence: 70 }),
  );
  return [...new Set((ModerationLabels ?? []).map((label) => label.ParentName || label.Name || '').filter((name) => REFUSED.has(name)))];
}

// Invoked asynchronously by submit with { jobId }.
export const handler = async (event: { jobId: string }): Promise<void> => {
  const result = await runGenerateJob(event.jobId, { stores, callTool, modelId: modelId(), urls, outputAllowed, moderate });
  if (result.outcome === 'SKIPPED') return;
  const name = result.outcome === 'DONE' ? 'Generated' : result.outcome === 'REJECTED' ? 'Rejected' : 'Failed';
  emitMetrics({ [name]: 1, TokensIn: result.tokensIn, TokensOut: result.tokensOut });
};
