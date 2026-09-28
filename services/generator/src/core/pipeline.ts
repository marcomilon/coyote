import type { z } from 'zod';
import type { Answers } from './answers';
import { callWithRetry, type CallTool, type Usage } from './bedrock';
import type { Note } from './questions';
import { briefSchema, type Brief } from './brief';
import { ModelContent, SiteContent } from './content';
import { checkContent, PolicyRejection, scrubModelContent } from './policy';
import { fixBrief, lintContent, looksEnglish } from './quality';
import { candidatesFor } from './variety';
import { answersBlock, briefSystemPrompt, briefUserPrompt, contentSystemPrompt, contentUserPrompt } from './prompt';

export interface GenerateOptions {
  callTool: CallTool;
  modelId: string;
  /** Seeds the theme and font candidates. */
  slug: string;
  /** The owner's answers to the model's questions. */
  notes?: Note[];
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
export async function generateSite(answers: Answers, { callTool, modelId, slug, notes = [] }: GenerateOptions): Promise<Generated> {
  const usage: Usage[] = [];

  const candidates = candidatesFor(slug);
  const themeIds = candidates.map((c) => c.theme.id) as [string, ...string[]];
  const fontIds = [...new Set(candidates.flatMap((c) => c.fontPairings))] as [string, ...string[]];

  const proposed = await callWithRetry(callTool, usage, {
    modelId,
    system: briefSystemPrompt(),
    guarded: answersBlock(answers, notes),
    user: briefUserPrompt(candidates),
    maxTokens: 1000,
    tool: {
      name: 'design_brief',
      description: 'Record the design direction for this business.',
      schema: briefSchema(themeIds, fontIds),
    },
  });

  // The scene becomes an image prompt and must be English. One more try, then no photo rather than a wrong one.
  let scene = proposed.heroScene;
  if (!looksEnglish(scene)) {
    const again = await callWithRetry(callTool, usage, {
      modelId,
      system: briefSystemPrompt(),
      guarded: answersBlock(answers, notes),
      user: `${briefUserPrompt(candidates)}\n\nYour previous heroScene was not in English. Write every field as before, and heroScene in English only.`,
      maxTokens: 1000,
      tool: { name: 'design_brief', description: 'Record the design direction for this business.', schema: briefSchema(themeIds, fontIds) },
    });
    scene = looksEnglish(again.heroScene) ? again.heroScene : '';
  }
  const brief = { ...fixBrief(proposed, candidates), heroScene: scene };

  const contentRequest = {
    modelId,
    system: contentSystemPrompt(answers.lang),
    guarded: answersBlock(answers, notes),
    user: contentUserPrompt(brief),
    maxTokens: 3000,
    tool: { name: 'publish_content', description: 'Publish the copy for this business website.', schema: ModelContent },
  };
  let written = await callWithRetry(callTool, usage, contentRequest);

  // Slop lint: one regeneration with the problems as feedback. A second miss ships as it is;
  // the lint is about taste, the policy check below is about safety.
  const problems = lintContent(written, answers.lang, `${answers.about} ${answers.contact.address ?? ''} ${notes.map((n) => n.answer).join(' ')}`);
  if (problems.length > 0) {
    written = await callWithRetry(callTool, usage, {
      ...contentRequest,
      user: `${contentRequest.user}\n\nYour previous copy had these problems. Write it again without them:\n- ${problems.join('\n- ')}`,
    });
  }

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
