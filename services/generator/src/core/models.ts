import type { Usage } from './bedrock';

/**
 * The one place that names a model. Everything else reads `modelId()` / `prescreenModelId()`.
 * BEDROCK_MODEL_ID and PRESCREEN_MODEL_ID override them (the CDK stack sets both on the Lambdas).
 */

/** Asks the owner's follow-up questions (plan_site) and answers the chat. Opus writes the page (page-writer.ts). */
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
 * Photos the page writer makes (make_image). Bedrock has no text-to-image model in us-east-1, so this one call goes
 * to us-west-2. IMAGE_MODEL_ID overrides it.
 */
export const DEFAULT_IMAGE_MODEL_ID = 'stability.stable-image-core-v1:1';
export const IMAGE_MODEL_REGION = 'us-west-2';

export function imageModelId(env: Record<string, string | undefined> = process.env): string {
  return env.IMAGE_MODEL_ID || DEFAULT_IMAGE_MODEL_ID;
}

/**
 * USD per million tokens, list prices. The `us.` Bedrock profiles cost 10% more than the global ones. Cache reads
 * bill at 0.1× input, cache writes at 1.25×.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  [DEFAULT_MODEL_ID]: { input: 1.1, output: 5.5 },
  [DEFAULT_PRESCREEN_MODEL_ID]: { input: 0.33, output: 2.75 },
};
/** USD per photo, Stable Image Core on Bedrock. */
export const IMAGE_PRICE = 0.04;

/** What one model call cost in USD; a `make_image` row is one photo. Undefined: a model with no listed price. */
export function usageCost(u: Usage): number | undefined {
  if (u.step === 'make_image') return IMAGE_PRICE;
  const price = PRICES[u.modelId];
  if (!price) return undefined;
  const input = u.inputTokens + (u.cacheReadTokens ?? 0) * 0.1 + (u.cacheWriteTokens ?? 0) * 1.25;
  return (input * price.input + u.outputTokens * price.output) / 1_000_000;
}
