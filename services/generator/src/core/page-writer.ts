import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Answers, PageGoal } from './answers';
import type { Usage } from './bedrock';
import type { Contact } from './content';
import { DEFAULT_PAGE_SKILL } from './frontend-design';
import { countryOf } from './phones';
import type { Note } from './questions';

/**
 * The site writer: Claude Opus 5.5 through Anthropic's API, with a skill (frontend-design by default) as its system prompt
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

/**
 * The skill sent as the system prompt, switched by `./coyote.sh page-skill` (SSM PAGE_SKILL_PARAMETER names a
 * `<name>.md` in the PAGE_SKILLS_BUCKET, or `none`). The bundled frontend-design skill is the default.
 */
export interface PageSkill {
  name: string;
  text: string;
}
export { DEFAULT_PAGE_SKILL };
/** The switch's value that turns the skill off. */
export const NO_SKILL = 'none';

/** A SKILL.md as the model reads it: without its YAML frontmatter. */
export const skillText = (markdown: string): string => markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

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
  /** The owner's main goal for the site (the form's answer). Unset: nothing said (WhatsApp is the main contact either way). */
  goal?: PageGoal;
  notes: Note[];
  photos: PagePhoto[];
  /** New sites only: the direction nudge. */
  look?: Look;
  /** Edits: the current page and the owner's change request. */
  current?: string;
  instruction?: string;
}

/** Photo shapes the image model makes. */
export const IMAGE_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

/**
 * The make_image tool (the owner's "Fotos creadas con IA" toggle and `./coyote.sh page-images`): makes and saves a
 * photo. Resolves to its file, relative to the page, or to why there is none (the page writer draws SVG instead).
 */
export type MakeImage = (input: { description: string; aspect: ImageAspect }) => Promise<{ file: string; bytes: Uint8Array } | { error: string }>;

export const MAKE_IMAGE_TOOL = {
  name: 'make_image',
  description:
    'Makes a photo for the page with an image model and saves it next to the page. Describe one scene in English: subject, setting, light, framing. The model cannot write: no text, signs, or logos in the scene. Returns the file to use in the page, as a relative URL.',
  input_schema: {
    type: 'object' as const,
    properties: {
      description: { type: 'string', description: 'The scene, in English.' },
      aspect: { type: 'string', enum: [...IMAGE_ASPECTS] },
    },
    required: ['description', 'aspect'],
  },
};

/**
 * Writes a page. Resolves to the raw reply text; parsePage extracts the document. `model` defaults to pageModel(),
 * `skill` to the frontend-design skill; null sends no skill. With `makeImage`, the model may call the make_image tool.
 */
export type WritePage = (
  request: PageRequest,
  options: { effort: PageEffort; model?: string; skill?: PageSkill | null; makeImage?: MakeImage },
) => Promise<{ text: string; usage: Usage; stopReason: string | null }>;

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

/**
 * The site's language, from the business's country (its WhatsApp number): the Spanish of that country, so the
 * words, the "tú" or "vos", and the tone are local. A Brazilian number or the Portuguese form: Brazilian
 * Portuguese. +1 is Puerto Rico, the Dominican Republic, or the US: plain Latin American Spanish. WhatsApp numbers
 * are always from the form's country list (phones.ts `validForCountry`).
 */
export function siteLanguage(answers: Answers): string {
  const country = countryOf(answers.contact.whatsapp);
  if (answers.lang === 'pt' || !country || country.iso === 'BR') return 'Brazilian Portuguese';
  if (country.dial === '1') return 'Latin American Spanish';
  return `Spanish, written the way people in ${new Intl.DisplayNames(['en'], { type: 'region' }).of(country.iso)} talk`;
}

function contactLines(contact: Contact): string {
  return [
    `- Phone and WhatsApp: +${contact.whatsapp} (customers write on WhatsApp or call this number)`,
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
export function pagePrompt({ answers, notes, photos, look, goal, current, instruction }: PageRequest, skill: string | null = DEFAULT_PAGE_SKILL.name, images = false): string {
  const details = notes.map((n) => `  - ${n.question} ${n.answer}`).join('\n');
  const business = [
    `- Name: ${answers.businessName}`,
    `- What it does: ${answers.about}`,
    details && `- More details from the owner:\n${details}`,
    contactLines(answers.contact),
    `- Language of the site: ${siteLanguage(answers)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const files = photos.map((p) => p.file);
  const make = 'make photos with the make_image tool (describe each scene in English)';
  const photosLine =
    (files.length === 0
      ? `There are no photos of the business: where the page needs images, ${images ? `${make}, or draw them as SVG` : 'draw them as SVG'}. `
      : files.length === 1 ? `There is a photo of the business at ${files[0]}. ` : `There are photos of the business at ${files.join(', ')}. `) +
    (images && files.length > 0 ? `Where the page needs more images, you can ${make}. ` : '');

  if (current !== undefined) {
    return `${skill ? `Use the ${skill} skill. ` : ''}This is the one-page website of this small business:

${business}

\`\`\`html
${current}
\`\`\`

The owner asks for this change: ${instruction}

${photosLine}Keep everything else as it is, and don't invent facts the owner didn't give. Reply with the complete HTML file.`;
  }

  const goalLine = goal
    ? `${
        {
          whatsapp: 'The owner mostly wants visitors to message them on WhatsApp.',
          call: 'The owner mostly wants visitors to call them.',
          visit: 'The owner mostly wants visitors to come to the place.',
          book: 'The owner mostly wants visitors to book an appointment.',
        }[goal]
      }\n\n`
    : '';
  const lookLine = look
    ? `For the look, go with whichever of these suits the business best: ${look.tones[0]}, ${look.tones[1]}, or ${look.tones[2]}, on a ${look.dark ? 'dark' : 'light'} background${look.noTicker ? ', without a scrolling ticker or marquee strip' : ''}.\n\n`
    : '';
  return `${skill ? `Use the ${skill} skill to create` : 'Create'} a one-page website for this small business, as a single HTML file.

${business}

${goalLine}${lookLine}${photosLine}Don't invent facts the owner didn't give.`;
}

/** The reply's HTML document: the last ```html block, or a bare document. */
export function parsePage(text: string): string | undefined {
  const fenced = [...text.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  const html = (fenced ?? /<!doctype html[\s\S]*<\/html>/i.exec(text)?.[0])?.trim();
  return html && html.length > 500 ? html : undefined;
}

/** The API request for a page. */
export function pageParams(request: PageRequest, model: string, effort: PageEffort, skill: PageSkill | null = DEFAULT_PAGE_SKILL, images = false): Anthropic.MessageStreamParams {
  // The photos go first, in the order the request names them, so the design can follow them.
  const content: Anthropic.ContentBlockParam[] = [
    ...request.photos.map((p): Anthropic.ContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: Buffer.from(p.bytes).toString('base64') } })),
    { type: 'text', text: pagePrompt(request, skill?.name ?? null, images) },
  ];
  return {
    model,
    max_tokens: 64000,
    ...(skill && { system: skill.text }),
    messages: [{ role: 'user', content }],
    ...(images && { tools: [MAKE_IMAGE_TOOL] }),
    ...(takesEffort(model) && { output_config: { effort } }),
  } as Anthropic.MessageStreamParams;
}

/** Tool rounds before the page writer must answer with the page (the image cap itself is MakeImage's). */
const MAX_TOOL_ROUNDS = 6;

/** Runs the make_image calls of one reply, together. A failure is a result the model reads, never an exception. */
async function runImageTools(content: Anthropic.ContentBlock[], makeImage: MakeImage): Promise<Anthropic.ToolResultBlockParam[]> {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  return Promise.all(
    calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
      const input = call.input as { description?: unknown; aspect?: unknown };
      const aspect = IMAGE_ASPECTS.includes(input.aspect as ImageAspect) ? (input.aspect as ImageAspect) : '16:9';
      const made =
        call.name !== MAKE_IMAGE_TOOL.name || typeof input.description !== 'string'
          ? { error: 'unknown tool or no description' }
          : await makeImage({ description: input.description, aspect }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }));
      if ('error' in made) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No photo: ${made.error}. Draw this image as SVG instead.` };
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(made.bytes).toString('base64') } },
          { type: 'text', text: `Saved as ${made.file}` },
        ],
      };
    }),
  );
}

/** Anthropic's API, streaming (a page is 10–30k tokens), thinking on at the given effort; with make_image, a tool loop. `api`: tests. */
export function anthropicWritePage(env: Record<string, string | undefined> = process.env, api?: Pick<Anthropic, 'messages'>): WritePage {
  let client = api;
  return async (request, { effort, model = pageModel(env), skill = DEFAULT_PAGE_SKILL, makeImage }) => {
    client ??= new Anthropic({ apiKey: await anthropicApiKey(env), maxRetries: 2 });
    const params = pageParams(request, model, effort, skill, !!makeImage);
    const signal = AbortSignal.timeout(PAGE_DEADLINE_MS); // one deadline for every round
    const messages = [...params.messages];
    let inputTokens = 0;
    let outputTokens = 0;
    const texts: string[] = []; // every round's text: parsePage takes the last HTML block
    for (let round = 0; ; round++) {
      const last = round === MAX_TOOL_ROUNDS;
      const message = await client.messages
        .stream({ ...params, messages, ...(last && { tool_choice: { type: 'none' } }) } as Anthropic.MessageStreamParams, { signal })
        .finalMessage();
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      texts.push(...message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])));
      if (message.stop_reason === 'tool_use' && makeImage && !last) {
        messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: await runImageTools(message.content, makeImage) });
        continue;
      }
      return { text: texts.join('\n'), stopReason: message.stop_reason, usage: { step: request.current !== undefined ? 'edit_page' : 'write_page', modelId: model, inputTokens, outputTokens } };
    }
  };
}
