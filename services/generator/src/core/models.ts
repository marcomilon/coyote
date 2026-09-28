/**
 * The one place that names a model. Everything else reads `modelId()` / `prescreenModelId()`.
 * BEDROCK_MODEL_ID and PRESCREEN_MODEL_ID override them (the CDK stack sets both on the Lambdas).
 */

/** Writes the copy (design_brief, publish_content, plan_site, edit_content). The themes carry the design. */
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The pre-screen runs on every request, including the ones it rejects, so it stays on a cheaper model. */
export const DEFAULT_PRESCREEN_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

export function modelId(env: Record<string, string | undefined> = process.env): string {
  return env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
}

export function prescreenModelId(env: Record<string, string | undefined> = process.env): string {
  return env.PRESCREEN_MODEL_ID || DEFAULT_PRESCREEN_MODEL_ID;
}

/** Claude models on Bedrock: prompt caching, and no forced tool choice (Opus 5.5 rejects it). */
export const isClaude = (id: string) => id.includes('anthropic.claude');

/** The effort setting exists on the newer Claude models only; Haiku 4.5 rejects it. */
export const supportsEffort = (id: string) => isClaude(id) && !id.includes('claude-haiku-4-5');

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
