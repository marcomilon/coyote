import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { sesSendEmail } from '../aws/mail';
import { snsAnnounce } from '../aws/notices';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed, stabilityImage } from '../core/bedrock';
import { runGenerateJob } from '../core/generate-job';
import { emitMetrics } from '../core/metrics';
import { imageModelId, modelId, prescreenModelId } from '../core/models';
import { anthropicWritePage, DEFAULT_PAGE_SKILL, NO_SKILL, pageEffort, pageModel, skillText, type PageSkill } from '../core/page-writer';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));
const rekognition = new RekognitionClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});
const writePage = anthropicWritePage();
const imageModel = imageModelId();
const generateImage = stabilityImage(imageModel);
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

/** A switch in SSM (`./coyote.sh page-model`, `page-skill`, `page-look`, `page-images`), read for every job so a change applies to the next one. */
async function setting(parameter: string | undefined): Promise<string | undefined> {
  if (!parameter) return undefined;
  try {
    return (await ssm.send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value;
  } catch (error) {
    console.error(`${parameter} unreadable, using the default`, error);
    return undefined;
  }
}

/** The page-skill switch: `none`, or a `<name>.md` in the skills bucket. Unreadable: the bundled frontend-design. */
async function pageSkill(): Promise<PageSkill | null> {
  const name = await setting(process.env.PAGE_SKILL_PARAMETER);
  if (name === NO_SKILL) return null;
  if (!name || name === DEFAULT_PAGE_SKILL.name || !process.env.PAGE_SKILLS_BUCKET) return DEFAULT_PAGE_SKILL;
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: process.env.PAGE_SKILLS_BUCKET, Key: `${name}.md` }));
    const text = skillText((await Body?.transformToString()) ?? '');
    if (text) return { name, text };
    console.error(`page skill ${name} is empty, using ${DEFAULT_PAGE_SKILL.name}`);
  } catch (error) {
    console.error(`page skill ${name} unreadable, using ${DEFAULT_PAGE_SKILL.name}`, error);
  }
  return DEFAULT_PAGE_SKILL;
}

// Invoked asynchronously with { jobId } by submit, by the answers route, and by an owner's edit.
export const handler = async (event: { jobId: string }): Promise<void> => {
  const [model, skill, look, images] = await Promise.all([
    setting(process.env.PAGE_MODEL_PARAMETER).then((value) => pageModel(process.env, value)),
    pageSkill(),
    setting(process.env.PAGE_LOOK_PARAMETER).then((value) => value !== 'off'),
    setting(process.env.PAGE_IMAGES_PARAMETER).then((value) => value !== 'off'),
  ]);
  console.log(JSON.stringify({ pageModel: model, pageSkill: skill?.name ?? NO_SKILL, pageLook: look ? 'on' : 'off', pageImages: images ? 'on' : 'off' }));
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
    pageModel: model,
    pageSkill: skill,
    pageLook: look,
    pageImages: images,
    generateImage,
    imageModelId: imageModel,
    sendEmail,
    announce,
  });
  if (result.outcome === 'SKIPPED') return;
  const name = ({ DONE: 'Generated', NEEDS_INPUT: 'NeedsInput', REJECTED: 'Rejected', FAILED: 'Failed' } as const)[result.outcome];
  emitMetrics({ [name]: 1, TokensIn: result.tokensIn, TokensOut: result.tokensOut });
};
