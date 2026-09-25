import type { Answers } from './answers';
import { normalizeForMatch } from './brands';
import { callWithRetry, ModelOutputError, type CallText, type CallTool, type Effort, type ImageInput, type Usage } from './bedrock';
import type { Media } from './content';
import { checkTexts, contactInText, PolicyRejection, type Violation } from './policy';
import { answersBlock, BANNED_PHRASES, editUserPrompt, planSystemPrompt, planUserPrompt, siteSystemPrompt, writeUserPrompt } from './prompt';
import { checkQuestions, CONTACT_TYPES, Plan, type Note, type Question } from './questions';
import { sanitizePage, type PageText } from './sanitize';

/**
 * The model calls that make a site: plan_site (ask the owner first, or not), then write_site for a new page
 * or edit_site for a change. The model writes HTML; everything it writes goes through the sanitizer and the
 * text checks before anything is stored.
 */

export interface WriterDeps {
  callTool: CallTool;
  /** The page comes back as plain text: models write better HTML that way than inside a tool call. */
  callText: CallText;
  modelId: string;
  /** Output guardrail on text we show. Resolves to true when it may be shown. */
  outputAllowed(text: string): Promise<boolean>;
}

export interface SiteInput {
  answers: Answers;
  notes: Note[];
  media: Media;
  /** The logo and photos, sent to the model as image blocks. */
  images: ImageInput[];
  /** Edits: the owner's change request and the current page source. */
  instruction?: string;
  current?: string;
}

/** Effort for write_site and edit_site. Chosen in the bake-off; WRITE_EFFORT overrides it. */
export function writeEffort(env: Record<string, string | undefined> = process.env): Effort {
  const value = env.WRITE_EFFORT;
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

/** Resolves to the questions to show the owner; empty when the model is ready to build. */
export async function planSite(input: SiteInput, deps: WriterDeps): Promise<{ questions: Question[]; usage: Usage[] }> {
  const usage: Usage[] = [];
  const plan = await callWithRetry(deps.callTool, usage, {
    modelId: deps.modelId,
    system: planSystemPrompt(),
    guarded: answersBlock(input.answers, input.notes, input.instruction),
    user: planUserPrompt({ lang: input.answers.lang, contact: input.answers.contact, media: input.media, edit: input.instruction !== undefined }),
    images: input.images,
    maxTokens: 8000,
    effort: 'low',
    tool: { name: 'plan_site', description: 'Record whether the page can be built now, or the questions to ask the owner first.', schema: Plan },
  });
  // Never ask for a contact detail the owner already gave (the model sometimes does).
  const contact = input.answers.contact as Record<string, string | undefined>;
  const asked = (plan.ready ? [] : (plan.questions ?? [])).filter((q) => !(q.type in CONTACT_TYPES && contact[CONTACT_TYPES[q.type as keyof typeof CONTACT_TYPES]]));
  if (asked.length === 0) return { questions: [], usage };
  return { questions: await checkQuestions(asked, deps.outputAllowed), usage };
}

/** The write_site / edit_site reply: an optional "Hero scene:" line, then the page in one ```html block. */
export function parsePageReply(reply: string): { html: string; heroScene?: string } | undefined {
  const fenced = [...reply.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  const bare = /<!doctype html[\s\S]*<\/html>/i.exec(reply)?.[0];
  const html = (fenced ?? bare)?.trim();
  if (!html || html.length < 200) return undefined;
  const scene = /^\s*hero scene:\s*(.+)$/im.exec(reply.split(/```html/i)[0] ?? '')?.[1]?.trim();
  return { html, heroScene: scene ? scene.slice(0, 300) : undefined };
}

export interface Written {
  /** The sanitized page with its placeholders (stored as the draft's source). */
  source: string;
  text: PageText;
  heroScene?: string;
  usage: Usage[];
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** Copy problems worth one regeneration. Written for the model. */
function lintCopy(text: PageText, answers: Answers): string[] {
  const problems: string[] = [];
  const all = normalizeForMatch(text.texts.join(' \n '));
  for (const phrase of BANNED_PHRASES[answers.lang]) {
    if (all.includes(normalizeForMatch(phrase))) problems.push(`Do not use the phrase "${phrase}" or a close variant.`);
  }
  if (text.texts.some((t) => EMOJI.test(t))) problems.push('Remove every emoji from the text (draw icons as SVG instead).');
  if (/!{2,}|¡[^!]*![^¡]*¡[^!]*!/.test(text.texts.join(' '))) problems.push('Too many exclamation marks. Use a calm, concrete voice.');
  return problems;
}

/**
 * Writes (or edits) the page. Sanitizer violations and contact details written into the text get one
 * regeneration with the problems as feedback; a second miss rejects the page. Quality lint gets one
 * regeneration too, but a second miss ships as it is: the lint is about taste, the rest is about safety.
 * Throws PolicyRejection. Every model call is recorded in `usage`, including the calls of a rejected page.
 */
export async function writeSite(input: SiteInput, deps: WriterDeps, usage: Usage[] = []): Promise<Written> {
  const edit = input.current !== undefined;
  const base = {
    modelId: deps.modelId,
    system: siteSystemPrompt(input.answers.lang),
    guarded: answersBlock(input.answers, input.notes, input.instruction),
    user: edit ? editUserPrompt(input.current!, { contact: input.answers.contact, media: input.media }) : writeUserPrompt({ contact: input.answers.contact, media: input.media }),
    images: input.images,
    maxTokens: 32_000,
    effort: writeEffort(),
    stream: true,
    step: edit ? 'edit_site' : 'write_site',
  };

  /** One page from the model. A reply with no page, or cut off, gets one more try with the problem as feedback. */
  const writePage = async (user: string): Promise<{ html: string; heroScene?: string }> => {
    let problem = '';
    for (let tries = 0; tries < 2; tries++) {
      try {
        const reply = await deps.callText({ ...base, user: problem ? `${user}\n\nYour previous reply was rejected: ${problem}` : user });
        usage.push(reply.usage);
        const page = parsePageReply(reply.text);
        if (page) return page;
        problem = 'it did not contain the complete HTML document in one ```html code block.';
      } catch (error) {
        if (!(error instanceof ModelOutputError)) throw error;
        usage.push(error.usage);
        problem = error.issues;
      }
    }
    throw new Error(`no page from the model: ${problem}`);
  };

  let feedback: string[] = [];
  let fallback: Written | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = feedback.length > 0 ? `${base.user}\n\nYour previous page had these problems. Write it again, fixing all of them:\n- ${feedback.join('\n- ')}` : base.user;
    const written = await writePage(user);
    const page = sanitizePage(written.html);

    const policy = checkTexts(page.text.texts, { businessName: input.answers.businessName, headlines: [page.text.title, ...page.text.h1] });
    if (policy.length > 0) throw new PolicyRejection(policy);

    const contact = page.text.texts.flatMap(contactInText);
    const problems = [
      ...page.violations,
      ...(contact.length > 0 ? [`Never write contact details or URLs in the text; use the placeholders. Found: ${[...new Set(contact)].slice(0, 5).join(', ')}`] : []),
    ];
    if (problems.length > 0) {
      if (fallback) return fallback; // the first page was safe and only missed the lint
      if (attempt === 1) throw new PolicyRejection(problems.map((detail): Violation => ({ code: 'sanitizer', detail: detail.slice(0, 200) })));
      feedback = problems;
      continue;
    }

    const result: Written = { source: page.html, text: page.text, heroScene: written.heroScene, usage };
    const lint = [...page.lint, ...lintCopy(page.text, input.answers)];
    if (lint.length === 0 || attempt === 1) return result;
    fallback = result;
    feedback = lint;
  }
  return fallback!;
}
