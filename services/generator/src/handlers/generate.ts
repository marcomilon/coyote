import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { sesSendEmail } from '../aws/mail';
import { snsAnnounce } from '../aws/notices';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { runGenerateJob } from '../core/generate-job';
import { emitMetrics } from '../core/metrics';
import { modelId, prescreenModelId } from '../core/models';
import { anthropicWritePage, pageEffort, pageModel } from '../core/page-writer';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));
const rekognition = new RekognitionClient({});
const ssm = new SSMClient({});
const writePage = anthropicWritePage();
const sendEmail = sesSendEmail(urls.mailFrom);
const announce = snsAnnounce(process.env.SITE_NOTICES_TOPIC_ARN);

/** Top-level moderation categories we refuse. Alcohol and swimwear are fine: restaurants and beachwear shops exist. */
const REFUSED = new Set(['Explicit', 'Non-Explicit Nudity of Intimate parts and Kissing', 'Violence', 'Visually Disturbing', 'Hate Symbols', 'Drugs & Tobacco', 'Gambling']);

async function moderate(key: string): Promise<string[]> {
  const { ModerationLabels } = await rekognition.send(
    new DetectModerationLabelsCommand({ Image: { S3Object: { Bucket: process.env.SITES_BUCKET, Name: key } }, MinConfidence: 70 }),
  );
  return [...new Set((ModerationLabels ?? []).map((label) => label.ParentName || label.Name || '').filter((name) => REFUSED.has(name)))];
}

/** The page-model switch (`./coyote.sh page-model`), read for every job so a change applies to the next one. */
async function pageModelSetting(): Promise<string | undefined> {
  if (!process.env.PAGE_MODEL_PARAMETER) return undefined;
  try {
    return (await ssm.send(new GetParameterCommand({ Name: process.env.PAGE_MODEL_PARAMETER }))).Parameter?.Value;
  } catch (error) {
    console.error('page-model parameter unreadable, using the default', error);
    return undefined;
  }
}

// Invoked asynchronously with { jobId } by submit, by the answers route, and by an owner's edit.
export const handler = async (event: { jobId: string }): Promise<void> => {
  const result = await runGenerateJob(event.jobId, {
    stores,
    callTool,
    modelId: modelId(),
    prescreenModelId: prescreenModelId(),
    urls,
    outputAllowed,
    moderate,
    now: Date.now,
    writePage,
    pageEffort: pageEffort(),
    pageModel: pageModel(process.env, await pageModelSetting()),
    sendEmail,
    announce,
  });
  if (result.outcome === 'SKIPPED') return;
  const name = ({ DONE: 'Generated', NEEDS_INPUT: 'NeedsInput', REJECTED: 'Rejected', FAILED: 'Failed' } as const)[result.outcome];
  emitMetrics({ [name]: 1, TokensIn: result.tokensIn, TokensOut: result.tokensOut });
};
