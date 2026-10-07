import type { Answers } from './answers';
import { callWithRetry, type CallTool, type ImageInput, type Usage } from './bedrock';
import { answersBlock, planSystemPrompt, planUserPrompt } from './prompt';
import { checkQuestions, CONTACT_TYPES, Plan, type Note, type Question } from './questions';

/** plan_site: before the page writer, the model decides whether to ask the owner a few questions first. */

export interface WriterDeps {
  callTool: CallTool;
  modelId: string;
  /** Output guardrail on text we show. Resolves to true when it may be shown. */
  outputAllowed(text: string): Promise<boolean>;
}

export interface PlanInput {
  answers: Answers;
  notes: Note[];
  /** The logo and photos, sent to the model as image blocks. */
  images: ImageInput[];
  photos: number;
  /** Edits: the owner's change request. */
  instruction?: string;
}

/** Resolves to the questions to show the owner; empty when the model is ready to build. */
export async function planSite(input: PlanInput, deps: WriterDeps): Promise<{ questions: Question[]; usage: Usage[] }> {
  const usage: Usage[] = [];
  const plan = await callWithRetry(deps.callTool, usage, {
    modelId: deps.modelId,
    system: planSystemPrompt(),
    guarded: answersBlock(input.answers, input.notes, input.instruction),
    user: planUserPrompt({ lang: input.answers.lang, contact: input.answers.contact, photos: input.photos, edit: input.instruction !== undefined }),
    images: input.images,
    maxTokens: 4000,
    effort: 'low',
    tool: { name: 'plan_site', description: 'Record whether the page can be built now, or the questions to ask the owner first.', schema: Plan },
  });
  // Never ask for a contact detail the owner already gave (the model sometimes does).
  const contact = input.answers.contact as Record<string, string | undefined>;
  const asked = (plan.ready ? [] : (plan.questions ?? [])).filter((q) => !(q.type in CONTACT_TYPES && contact[CONTACT_TYPES[q.type as keyof typeof CONTACT_TYPES]]));
  if (asked.length === 0) return { questions: [], usage };
  return { questions: await checkQuestions(asked, deps.outputAllowed), usage };
}
