/**
 * The one place that names a model. Everything else reads `modelId()`.
 * Override with the BEDROCK_MODEL_ID env var (the CDK stack sets it on the Lambdas).
 */
export const DEFAULT_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

export function modelId(env: Record<string, string | undefined> = process.env): string {
  return env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
}

/**
 * Hero images for sites with no uploaded photos. Bedrock has no text-to-image model in us-east-1
 * (Nova Canvas reached end of life), so this one call goes to us-west-2. IMAGE_MODEL_ID overrides it;
 * HERO_IMAGE=off turns the feature off.
 */
export const DEFAULT_IMAGE_MODEL_ID = 'stability.stable-image-core-v1:1';
export const IMAGE_MODEL_REGION = 'us-west-2';

export function imageModelId(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.HERO_IMAGE === 'off') return undefined;
  return env.IMAGE_MODEL_ID || DEFAULT_IMAGE_MODEL_ID;
}
