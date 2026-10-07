import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Answers } from './answers';
import type { Usage } from './bedrock';
import type { Contact } from './content';
import { FRONTEND_DESIGN } from './frontend-design';
import type { Note } from './questions';

/**
 * The site writer: Claude Opus 5.5 through Anthropic's API, with the frontend-design skill as its system prompt
 * and a request written the way an owner would ask in chat. The page comes back as one HTML document; the
 * checks run on it afterwards (page-check.ts), not as rules in the prompt, because rules made the designs worse.
 */

/**
 * The page writer's models, by the name `./coyote.sh page-model` sets (the SSM parameter PAGE_MODEL_PARAMETER).
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

/** Haiku 4.5 rejects the effort setting. */
const takesEffort = (model: string) => !model.includes('claude-haiku-4-5');

export type PageEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const pageEffort = (env: Record<string, string | undefined> = process.env): PageEffort => (env.PAGE_EFFORT as PageEffort) || 'high';

/** Retries included, inside the generate Lambda's 10 minutes (the questions step runs first). */
const PAGE_DEADLINE_MS = 9 * 60 * 1000;

/** A photo the page may use, sent to the model as an image so it designs around it. */
export interface PagePhoto {
  file: string;
  label: string;
  bytes: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png';
}

/**
 * Each request starts from nothing, so Opus falls back on its favorite look for the kind of business (every
 * bakery cream and serif). A random nudge, in the skill's own words, spreads the sites out; Opus picks the one
 * direction of the three that suits the business. The tones are the skill's list (frontend-design.ts).
 * Opus's favorite eye-catcher is a scrolling ticker strip (10 of 12 pages had one), so most requests ask for a
 * page without one; a quarter say nothing, so some sites still get it.
 */
export const TONES = [
  'brutally minimal', 'maximalist', 'retro-futuristic', 'organic/natural', 'luxury/refined', 'playful/toy-like',
  'editorial/magazine', 'brutalist/raw', 'art deco/geometric', 'soft/pastel', 'industrial/utilitarian',
  'Swiss/international', 'hand-made/crafty', 'vintage signage', 'bold color-block', 'Memphis',
] as const;

export interface Look {
  tones: [string, string, string];
  dark: boolean;
  noTicker: boolean;
}

/** How often a new site's request asks for no ticker strip. */
const NO_TICKER_SHARE = 0.75;

/** Three different tones, a light or dark page, and usually no ticker strip. `random` is injectable for tests. */
export function pickLook(random: () => number = Math.random): Look {
  const pool: string[] = [...TONES];
  const tones = [0, 1, 2].map(() => pool.splice(Math.floor(random() * pool.length), 1)[0]!) as Look['tones'];
  return { tones, dark: random() < 0.4, noTicker: random() < NO_TICKER_SHARE };
}

export interface PageRequest {
  answers: Answers;
  notes: Note[];
  photos: PagePhoto[];
  /** New sites only: the direction nudge. */
  look?: Look;
  /** Edits: the current page and the owner's change request. */
  current?: string;
  instruction?: string;
}

/** Writes a page. Resolves to the raw reply text; parsePage extracts the document. `model` defaults to pageModel(). */
export type WritePage = (request: PageRequest, options: { effort: PageEffort; model?: string }) => Promise<{ text: string; usage: Usage; stopReason: string | null }>;

let key: Promise<string> | undefined;

/** The Anthropic API key: ANTHROPIC_API_KEY, or the secret named by ANTHROPIC_SECRET_NAME (default coyote/anthropic-api-key). */
export function anthropicApiKey(env: Record<string, string | undefined> = process.env): Promise<string> {
  if (env.ANTHROPIC_API_KEY) return Promise.resolve(env.ANTHROPIC_API_KEY);
  return (key ??= (async () => {
    const { SecretString } = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: env.ANTHROPIC_SECRET_NAME || 'coyote/anthropic-api-key' }));
    const value = (SecretString ?? '').trim();
    // A key/value secret from the console: the value that looks like an Anthropic key, whatever its field name.
    const found = value.startsWith('{') ? Object.values(JSON.parse(value) as Record<string, unknown>).find((v) => typeof v === 'string' && v.startsWith('sk-ant-')) : value;
    if (typeof found !== 'string' || !found) throw new Error('no Anthropic API key in the secret');
    return found;
  })());
}

function contactLines(contact: Contact): string {
  return [
    `- WhatsApp: +${contact.whatsapp} (the main way customers contact them)`,
    contact.phone && `- Phone: +${contact.phone}`,
    contact.email && `- Email: ${contact.email}`,
    contact.address && `- Address: ${contact.address}`,
    contact.instagram && `- Instagram: @${contact.instagram}`,
    contact.facebook && `- Facebook: facebook.com/${contact.facebook}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The request, worded like the chat request that gave the best designs. Keep it that way: no tags, notes, or
 * rules. Safety is the checks on the finished page (page-check.ts), not the prompt.
 */
export function pagePrompt({ answers, notes, photos, look, current, instruction }: PageRequest): string {
  const language = answers.lang === 'pt' ? 'Brazilian Portuguese' : 'Latin American Spanish';
  const details = notes.map((n) => `  - ${n.question} ${n.answer}`).join('\n');
  const business = [
    `- Name: ${answers.businessName}`,
    `- What it does: ${answers.about}`,
    details && `- More details from the owner:\n${details}`,
    contactLines(answers.contact),
    `- Language of the site: ${language}`,
  ]
    .filter(Boolean)
    .join('\n');
  const files = photos.map((p) => p.file);
  const photosLine =
    files.length === 0
      ? 'There are no photos of the business: where the page needs images, draw them as SVG. '
      : files.length === 1 ? `There is a photo of the business at ${files[0]}. ` : `There are photos of the business at ${files.join(', ')}. `;

  if (current !== undefined) {
    return `Use the frontend-design skill. This is the one-page website of this small business:

${business}

\`\`\`html
${current}
\`\`\`

The owner asks for this change: ${instruction}

${photosLine}Keep everything else as it is, and don't invent facts the owner didn't give. Reply with the complete HTML file.`;
  }

  const lookLine = look
    ? `For the look, go with whichever of these suits the business best: ${look.tones[0]}, ${look.tones[1]}, or ${look.tones[2]}, on a ${look.dark ? 'dark' : 'light'} background${look.noTicker ? ', without a scrolling ticker or marquee strip' : ''}.\n\n`
    : '';
  return `Use the frontend-design skill to create a one-page website for this small business, as a single HTML file.

${business}

${lookLine}${photosLine}Don't invent facts the owner didn't give.`;
}

/** The reply's HTML document: the last ```html block, or a bare document. */
export function parsePage(text: string): string | undefined {
  const fenced = [...text.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  const html = (fenced ?? /<!doctype html[\s\S]*<\/html>/i.exec(text)?.[0])?.trim();
  return html && html.length > 500 ? html : undefined;
}

/** The API request for a page. */
export function pageParams(request: PageRequest, model: string, effort: PageEffort): Anthropic.MessageStreamParams {
  // The photos go first, in the order the request names them, so the design can follow them.
  const content: Anthropic.ContentBlockParam[] = [
    ...request.photos.map((p): Anthropic.ContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: Buffer.from(p.bytes).toString('base64') } })),
    { type: 'text', text: pagePrompt(request) },
  ];
  return {
    model,
    max_tokens: 64000,
    system: FRONTEND_DESIGN,
    messages: [{ role: 'user', content }],
    ...(takesEffort(model) && { output_config: { effort } }),
  } as Anthropic.MessageStreamParams;
}

/** Anthropic's API, streaming (a page is 10–30k tokens), thinking on at the given effort. */
export function anthropicWritePage(env: Record<string, string | undefined> = process.env): WritePage {
  let client: Anthropic | undefined;
  return async (request, { effort, model = pageModel(env) }) => {
    client ??= new Anthropic({ apiKey: await anthropicApiKey(env), maxRetries: 2 });
    const message = await client.messages.stream(pageParams(request, model, effort), { signal: AbortSignal.timeout(PAGE_DEADLINE_MS) }).finalMessage();
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return {
      text,
      stopReason: message.stop_reason,
      usage: { step: request.current !== undefined ? 'edit_page' : 'write_page', modelId: model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  };
}
