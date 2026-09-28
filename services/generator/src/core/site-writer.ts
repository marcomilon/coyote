import type { Answers } from './answers';
import { callWithRetry, type CallTool, type ImageInput, type Usage } from './bedrock';
import { ModelContent, type SiteContent } from './content';
import { answersBlock, editSystemPrompt, editUserPrompt, planSystemPrompt, planUserPrompt } from './prompt';
import { checkQuestions, CONTACT_TYPES, Plan, type Note, type Question } from './questions';
import { scrubModelContent } from './policy';

/**
 * The model calls around a site besides the content itself (pipeline.ts): plan_site (ask the owner first, or
 * not) and edit_content (an owner's free-text change request).
 */

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

/** What edit_content may change: the copy, never contact details, the title, or the design. */
export const ContentEdit = ModelContent.pick({ headline: true, subhead: true, about: true, services: true, hours: true, location: true, ctaText: true }).partial();

/**
 * An owner's free-text change request → the edited copy. URLs and phone numbers the model wrote are removed
 * (scrubModelContent). The caller runs the content policy and the output guardrail on the result.
 */
export async function editContent(content: SiteContent, answers: Answers, notes: Note[], instruction: string, deps: WriterDeps, usage: Usage[]): Promise<SiteContent> {
  const edit = await callWithRetry(deps.callTool, usage, {
    modelId: deps.modelId,
    system: editSystemPrompt(content.lang),
    guarded: answersBlock(answers, notes, instruction),
    user: editUserPrompt(content),
    maxTokens: 4000,
    effort: 'low',
    tool: { name: 'edit_content', description: 'Record the fields of the copy that change.', schema: ContentEdit },
  });
  const merged = { ...content, ...Object.fromEntries(Object.entries(edit).filter(([, value]) => value !== undefined)) };
  const { businessName, lang, contact, media, ...model } = merged;
  return { ...scrubModelContent(ModelContent.parse(model)), businessName, lang, contact, media };
}
