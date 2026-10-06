import { z } from 'zod';
import { cleanContact, type ContactField } from './answers';
import { Contact } from './content';
import { checkTexts, contactInText, scrubText } from './policy';

/** Contact types map to a contact field. Their answers go into the site's contact details, never to the model. */
export const CONTACT_TYPES = {
  address: 'address',
  phone: 'phone',
  whatsapp: 'whatsapp',
  email: 'email',
  instagram: 'instagram',
  facebook: 'facebook',
} as const satisfies Record<string, ContactField>;

export const QuestionType = z.enum(['text', 'textarea', 'choice', 'multi', 'yesno', 'address', 'phone', 'whatsapp', 'email', 'instagram', 'facebook']);
export type QuestionType = z.infer<typeof QuestionType>;

const text = (max: number) => z.string().trim().min(1).max(max);

/** Model output shown in our app: kept strict, and always rendered with textContent. */
export const Question = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,30}$/).describe('Short snake_case id'),
    label: text(120).describe("The question, in the owner's language"),
    help: text(160).optional().describe('Optional hint under the question'),
    type: QuestionType,
    options: z.array(text(40)).min(2).max(6).optional().describe('Only for choice and multi: 2 to 6 short options'),
  })
  .refine((q) => (q.type === 'choice' || q.type === 'multi') === (q.options !== undefined), {
    message: 'options are required for choice and multi, and only for them',
  });
export type Question = z.infer<typeof Question>;

/** The `plan_site` tool input. */
export const Plan = z.object({
  ready: z.boolean().describe('true when there is enough information to build a good site'),
  questions: z
    .array(Question)
    .max(4)
    .optional()
    .describe('When not ready: at most 4 questions, all optional for the owner'),
});
export type Plan = z.infer<typeof Plan>;

/** A free-text answer, passed to the model inside the guarded answers block. */
export interface Note {
  question: string;
  answer: string;
}

export const MAX_ANSWER_LENGTH = 500;

/**
 * Keeps the questions that are safe to show: unique ids, no URLs or phone numbers, nothing the content
 * policy or the output guardrail objects to. A question that fails is dropped, not the whole plan.
 */
export async function checkQuestions(questions: Question[], outputAllowed: (text: string) => Promise<boolean>): Promise<Question[]> {
  const seen = new Set<string>();
  const kept: Question[] = [];
  for (const q of questions) {
    if (seen.has(q.id)) continue;
    const texts = [q.label, q.help ?? '', ...(q.options ?? [])].filter(Boolean);
    if (texts.some((t) => contactInText(t).length > 0)) continue;
    if (checkTexts(texts).length > 0) continue;
    seen.add(q.id);
    kept.push(q);
  }
  if (kept.length === 0) return kept;
  const all = kept.flatMap((q) => [q.label, q.help ?? '', ...(q.options ?? [])]).join('\n');
  return (await outputAllowed(all)) ? kept : [];
}

export type ApplyResult = { ok: true; contact: Partial<Contact>; notes: Note[] } | { ok: false; fields: string[] };

const RawValue = z.union([z.string().max(MAX_ANSWER_LENGTH), z.array(z.string().max(40)).max(6)]);

/**
 * The owner's answers to the questions. Contact answers are validated like the form fields and returned
 * as contact details; everything else becomes a note for the model. Unknown ids are an error.
 */
export function applyAnswers(questions: Question[], raw: unknown): ApplyResult {
  const parsed = z.record(z.string(), RawValue).safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, fields: ['answers'] };
  const byId = new Map(questions.map((q) => [q.id, q]));
  const fields: string[] = [];
  const contact: Partial<Record<ContactField, string>> = {};
  const notes: Note[] = [];

  for (const [id, value] of Object.entries(parsed.data)) {
    const q = byId.get(id);
    if (!q) {
      fields.push(id);
      continue;
    }
    if (q.type in CONTACT_TYPES) {
      const field = CONTACT_TYPES[q.type as keyof typeof CONTACT_TYPES];
      const cleaned = typeof value === 'string' ? cleanContact(field, value) : undefined;
      if (cleaned === undefined) continue; // skipped
      if (!Contact.shape[field].safeParse(cleaned).success) fields.push(id);
      else contact[field] = cleaned;
      continue;
    }
    let answer: string;
    if (q.type === 'multi' || q.type === 'choice') {
      const picked = (Array.isArray(value) ? value : [value]).filter(Boolean);
      if (!picked.every((option) => q.options?.includes(option))) {
        fields.push(id);
        continue;
      }
      answer = picked.join(', ');
    } else if (q.type === 'yesno') {
      if (typeof value !== 'string' || !['yes', 'no', ''].includes(value)) {
        fields.push(id);
        continue;
      }
      answer = value;
    } else {
      if (typeof value !== 'string') {
        fields.push(id);
        continue;
      }
      // A contact detail typed into a text answer never reaches the page: it is scrubbed here.
      answer = scrubText(value);
    }
    if (answer) notes.push({ question: q.label, answer });
  }
  return fields.length > 0 ? { ok: false, fields } : { ok: true, contact, notes };
}
