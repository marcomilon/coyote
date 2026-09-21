import type { z } from 'zod';
import { THEMES, THEME_IDS } from '../../themes';
import type { Answers } from './answers';
import { ModelOutputError, type CallTool, type ToolRequest, type Usage } from './bedrock';
import { briefSchema, type Brief } from './brief';
import { ModelContent, SiteContent } from './content';
import { FONT_PAIRING_IDS } from './fonts';
import { checkContent, PolicyRejection, scrubModelContent } from './policy';
import { answersBlock, briefSystemPrompt, briefUserPrompt, contentSystemPrompt, contentUserPrompt } from './prompt';

export interface GenerateOptions {
  callTool: CallTool;
  modelId: string;
}

export interface Generated {
  brief: Brief;
  content: SiteContent;
  usage: Usage[];
}

/**
 * Answers → design brief → content. Contact details come from the answers, never from the model.
 * Throws PolicyRejection when the content breaks the content policy.
 */
export async function generateSite(answers: Answers, { callTool, modelId }: GenerateOptions): Promise<Generated> {
  const usage: Usage[] = [];

  // Phase 2a narrows both lists to seeded candidates.
  const themeIds = THEME_IDS;
  const fontIds = FONT_PAIRING_IDS;

  const brief = await callWithRetry(callTool, usage, {
    modelId,
    system: briefSystemPrompt(),
    guarded: answersBlock(answers),
    user: briefUserPrompt(themeIds.map((id) => THEMES[id]!), fontIds),
    maxTokens: 1000,
    tool: {
      name: 'design_brief',
      description: 'Record the design direction for this business.',
      schema: briefSchema(themeIds, fontIds),
    },
  });

  const written = await callWithRetry(callTool, usage, {
    modelId,
    system: contentSystemPrompt(answers.lang),
    guarded: answersBlock(answers),
    user: contentUserPrompt(brief),
    maxTokens: 3000,
    tool: {
      name: 'publish_content',
      description: 'Publish the copy for this business website.',
      schema: ModelContent,
    },
  });

  const content = SiteContent.parse({
    ...scrubModelContent(written),
    businessName: answers.businessName,
    lang: answers.lang,
    contact: answers.contact,
  });

  const violations = checkContent(content);
  if (violations.length > 0) throw new PolicyRejection(violations);

  return { brief, content, usage };
}

/** One retry, with the validation errors as feedback. */
async function callWithRetry<S extends z.ZodType>(
  callTool: CallTool,
  usage: Usage[],
  request: ToolRequest<S>,
): Promise<z.infer<S>> {
  try {
    const result = await callTool(request);
    usage.push(result.usage);
    return result.value;
  } catch (error) {
    if (!(error instanceof ModelOutputError)) throw error;
    usage.push(error.usage);
    const retry = await callTool({
      ...request,
      user: `${request.user}\n\nYour previous tool call was rejected. Fix these problems and call the tool again:\n${error.issues}`,
    });
    usage.push(retry.usage);
    return retry.value;
  }
}
