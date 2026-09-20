/**
 * The one place that names a model. Everything else reads `modelId()`.
 * Override with the BEDROCK_MODEL_ID env var (the CDK stack sets it on the Lambdas).
 */
export const DEFAULT_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

export function modelId(env: Record<string, string | undefined> = process.env): string {
  return env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
}
