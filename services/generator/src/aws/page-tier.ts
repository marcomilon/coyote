import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { modelId, modelTier, pageModel, writerModel, type ModelTier } from '../core/models';

const ssm = new SSMClient({});

/** One of the page-mode / page-model switches. Unreadable: the default (Opus, paid). */
async function setting(parameter: string | undefined): Promise<string | undefined> {
  if (!parameter) return undefined;
  return (await ssm.send(new GetParameterCommand({ Name: parameter })).catch(() => undefined))?.Parameter?.Value;
}

/** The tier of the model the next page write would use, from the switches the generate Lambda reads for each job. */
export async function pageTier(env: Record<string, string | undefined> = process.env): Promise<ModelTier> {
  const [mode, model] = await Promise.all([setting(env.PAGE_MODE_PARAMETER), setting(env.PAGE_MODEL_PARAMETER)]);
  return modelTier(writerModel(mode === 'template' ? 'template' : 'design', pageModel(env, model), modelId(env)));
}
