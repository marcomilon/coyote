import type { Usage } from './bedrock';

/**
 * The one place that names a model. Everything else reads `modelId()`, `prescreenModelId()`, `pageModel()`, `imageModelId()`.
 * BEDROCK_MODEL_ID and PRESCREEN_MODEL_ID override them (the CDK stack sets both on the Lambdas).
 * Every model Coyote uses has a tier in MODELS (below); a new model needs one before it is used.
 */

/** Asks the owner's follow-up questions (plan_site), answers the chat and fills templates. Opus writes the page (PAGE_MODELS). */
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
 * The page writer's models (page-writer.ts), by the name `./coyote.sh page-model` sets (the SSM parameter PAGE_MODEL_PARAMETER).
 * Haiku 4.5 is for testing the workflow cheaply; the designs are Opus's. Not on Bedrock: the account cannot use
 * Opus 5.5 there.
 */
export const PAGE_MODELS = { opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5' } as const;
export const DEFAULT_PAGE_MODEL = PAGE_MODELS.opus;

/** The model ID: PAGE_MODEL overrides it, then the switch's setting, then Opus (also for an unknown setting). */
export function pageModel(env: Record<string, string | undefined> = process.env, setting?: string): string {
  if (env.PAGE_MODEL) return env.PAGE_MODEL;
  return Object.hasOwn(PAGE_MODELS, setting ?? '') ? PAGE_MODELS[setting as keyof typeof PAGE_MODELS] : DEFAULT_PAGE_MODEL;
}

/** The model that writes the page: the cheap model fills a template, otherwise the page writer. Its tier decides if the write is paid. */
export const writerModel = (pageMode: string | undefined, writer: string | undefined, templateModel: string): string =>
  pageMode === 'template' ? templateModel : (writer ?? DEFAULT_PAGE_MODEL);

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
 * paid: a page this model writes uses the owner's free draft (and, with payments, a design credit). free: the owner
 * never pays for it. Stable Image Core is paid because its photos only come from a page write.
 */
export type ModelTier = 'paid' | 'free';

/**
 * Every model Coyote uses: its tier, and its USD per million tokens at list prices. The `us.` Bedrock profiles cost
 * 10% more than the global ones. Cache reads bill at 0.1× input, cache writes at 1.25×.
 */
export const MODELS: Record<string, { tier: ModelTier; input?: number; output?: number }> = {
  'claude-opus-5-5': { tier: 'paid', input: 4, output: 20 },
  'claude-sonnet-5-5': { tier: 'paid', input: 2, output: 10 },
  'claude-haiku-4-5': { tier: 'free', input: 1, output: 5 },
  'claude-haiku-5-5': { tier: 'free', input: 0.1, output: 0.5 },
  [DEFAULT_MODEL_ID]: { tier: 'free', input: 1.1, output: 5.5 },
  [DEFAULT_PRESCREEN_MODEL_ID]: { tier: 'free', input: 0.33, output: 2.75 },
  [DEFAULT_IMAGE_MODEL_ID]: { tier: 'paid' },
};

export const hasTier = (id: string) => Object.hasOwn(MODELS, id);

/** A model missing from MODELS counts as paid: it never gives free page writes. */
export const modelTier = (id: string): ModelTier => (hasTier(id) ? MODELS[id]!.tier : 'paid');

/** USD per photo, Stable Image Core on Bedrock. */
export const IMAGE_PRICE = 0.04;

/** What one model call cost in USD; a `make_image` row is one photo. Undefined: a model with no listed price. */
export function usageCost(u: Usage): number | undefined {
  if (u.step === 'make_image') return IMAGE_PRICE;
  const price = hasTier(u.modelId) ? MODELS[u.modelId] : undefined;
  if (price?.input === undefined || price.output === undefined) return undefined;
  const input = u.inputTokens + (u.cacheReadTokens ?? 0) * 0.1 + (u.cacheWriteTokens ?? 0) * 1.25;
  return (input * price.input + u.outputTokens * price.output) / 1_000_000;
}
