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
