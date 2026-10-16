import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Answers, PageGoal } from './answers';
import type { Usage } from './bedrock';
import type { Contact } from './content';
import type { DesignTraits } from './design-traits';
import { DEFAULT_PAGE_SKILL } from './frontend-design';
import { MAX_IMAGES } from './images';
import { DEFAULT_PAGE_MODEL, pageModel } from './models';
import { countryOf } from './phones';
import type { Note } from './questions';

/**
 * The site writer: Claude Opus 5.5 through Anthropic's API, with a skill (frontend-design by default) as its system prompt
 * and a request written the way an owner would ask in chat. The page comes back as one HTML document; the
 * checks run on it afterwards (page-check.ts), not as rules in the prompt, because rules made the designs worse.
 */

export { DEFAULT_PAGE_MODEL, PAGE_MODELS, pageModel } from './models';

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
  /** What the owner says the photo shows (Tus fotos). */
  caption?: string;
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

/**
 * Page structures for new designs: each redesign of a site gets one its earlier designs didn't use, so the designs
 * differ in structure, not only in fonts and colors. New sites don't get one: the skill picks freely.
 */
export const LAYOUTS = [
  { id: 'split', text: 'a big photo beside the headline, then sections in a clear grid' },
  { id: 'fullbleed', text: 'a full-bleed photo with the headline set over it, then wide full-width sections' },
  { id: 'editorial', text: 'an editorial magazine page: asymmetric columns, large pull quotes, generous white space' },
  { id: 'poster', text: 'a poster: the business name set huge across the first screen, the rest in bold blocks below' },
  { id: 'bento', text: 'a bento grid: tiles of different sizes for the offer, the photos, the hours and the contact' },
  { id: 'bands', text: 'full-width color bands, one per section, alternating text and photos' },
  { id: 'sidebar', text: 'a fixed side column with the name and navigation, the content scrolling beside it' },
  { id: 'collage', text: 'a scrapbook collage: overlapping photos, notes and stickers, slightly rotated' },
  { id: 'story', text: 'a single narrow column read top to bottom like a short story, photos between the paragraphs' },
  { id: 'menu', text: 'led by a menu board: the products and prices as a big list, the rest around it' },
] as const;

export interface Look {
  /** Three to choose from (pickLook); the bench sends one to see a style on its own. */
  tones: string[];
  dark: boolean;
  noTicker: boolean;
  /** New designs: the page structure (LAYOUTS id). */
  layout?: string;
}

/** What a site's earlier designs used, for a new design to avoid. `layouts`: oldest first. */
export interface UsedLooks {
  tones?: string[];
  dark?: boolean;
  layouts?: string[];
}

/** How often a new site's request asks for no ticker strip. */
const NO_TICKER_SHARE = 0.75;

/**
 * Three different tones, a light or dark page, and usually no ticker strip. `random` is injectable for tests.
 * A new design `avoid`s the site's earlier designs: none of their tones (the caller keeps at least 3 to pick from),
 * the other background, and a layout none of them used (all used: the one used longest ago).
 */
export function pickLook(random: () => number = Math.random, avoid?: UsedLooks): Look {
  const pool: string[] = TONES.filter((tone) => !avoid?.tones?.includes(tone));
  const tones = [0, 1, 2].map(() => pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  const dark = random() < 0.4;
  const look: Look = { tones, dark: avoid?.dark === undefined ? dark : !avoid.dark, noTicker: random() < NO_TICKER_SHARE };
  if (!avoid) return look;
  const used = avoid.layouts ?? [];
  const fresh = LAYOUTS.map((l) => l.id).filter((id) => !used.includes(id));
  const oldest = LAYOUTS.map((l) => l.id).sort((a, b) => used.lastIndexOf(a) - used.lastIndexOf(b))[0]!;
  return { ...look, layout: fresh.length > 0 ? fresh[Math.floor(random() * fresh.length)]! : oldest };
}

export interface PageRequest {
  answers: Answers;
  /** The owner's main goal for the site (the form's answer). Unset: nothing said (WhatsApp is the main contact either way). */
  goal?: PageGoal;
  notes: Note[];
  photos: PagePhoto[];
  /** New sites and new designs: the direction nudge. */
  look?: Look;
  /** A new design: what the current page looks like (design-traits.ts), so the new one looks different. */
  avoid?: DesignTraits;
  /** Edits: the current page and the owner's change request. */
  current?: string;
  instruction?: string;
  /** Edits: texts on the current page that the owner wrote. */
  keep?: string[];
  /** Edits: the owner's photos the current page shows. */
  keepPhotos?: string[];
  /** A new design (an instruction with no current page): the texts the page has now, to use again. */
  texts?: string[];
}

/** Photo shapes the image model makes: only ones Stable Image Core accepts (it has no 4:3 or 3:4). */
export const IMAGE_ASPECTS = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

/**
 * The make_image tool (the owner's "Fotos creadas con IA" toggle and `./coyote.sh page-images`): makes and saves a
 * photo. Resolves to its file, relative to the page, or to why there is none (the page writer leaves that image out),
 * and to how many photos are left, so the page writer doesn't spend a round finding out.
 */
export type MakeImage = (input: { description: string; aspect: ImageAspect }) => Promise<({ file: string; bytes: Uint8Array } | { error: string }) & { left?: number }>;

export const MAKE_IMAGE_TOOL = {
  name: 'make_image',
  description:
    `Makes a photo for the page with an image model and saves it next to the page. Describe one scene in English: subject, setting, light, framing. The model cannot write, and a photo with any words in it is refused: pick scenes with no text, signs, logos, labels, menus, packaging, or storefronts. Prefer scenes of the business's products, work, tools and place over people; show people only when the scene really needs them. The model draws hands badly, and a photo with a hand drawn wrong is refused: pick scenes where no hands show. When it does, people are from the business's country in Latin America and look like ordinary people there: describe them naturally, without exaggerated or stereotyped features or costumes. At most ${MAX_IMAGES} photos per page. Returns the file to use in the page, as a relative URL.`,
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
  return `Spanish as it is written in ${new Intl.DisplayNames(['en'], { type: 'region' }).of(country.iso)}, without slang`;
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
export function pagePrompt({ answers, notes, photos, look, avoid, goal, current, instruction, keep, keepPhotos, texts }: PageRequest, skill: string | null = DEFAULT_PAGE_SKILL.name, images = false): string {
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
  const logo = photos.find((p) => p.file.startsWith('assets/logo'))?.file;
  const files = photos.filter((p) => p.file !== logo).map((p) => (p.caption ? `${p.file} ("${p.caption}")` : p.file));
  const make = 'make photos with the make_image tool (describe each scene in English)';
  const photosLine =
    (logo ? `The business's logo is at ${logo}. ` : '') +
    (files.length === 0
      ? `There are no photos of the business: where the page needs images, ${images ? `${make} instead of drawing them as SVG` : 'draw them as SVG'}. `
      : files.length === 1 ? `There is a photo of the business at ${files[0]}. ` : `There are photos of the business at ${files.join(', ')}. `) +
    (images && files.length > 0 ? `Where the page needs more images, ${make} instead of drawing them as SVG. ` : '');

  if (current !== undefined) {
    return `${skill ? `Use the ${skill} skill. ` : ''}This is the one-page website of this small business:

${business}

\`\`\`html
${current}
\`\`\`

The owner asks for this change: ${instruction}

${keep?.length ? `The owner wrote these texts themselves; keep them word for word unless the change asks otherwise:\n${keep.map((text) => `- ${text}`).join('\n')}\n\n` : ''}${photosLine}${keepPhotos?.length ? `Keep the owner's photos that the page shows now (${keepPhotos.join(', ')}) on the page, unless the change asks otherwise. ` : ''}Keep everything else as it is, and don't invent facts the owner didn't give. Reply with the complete HTML file.`;
  }

  const goalLine = goal
    ? `${
        {
          info: 'The owner mostly wants visitors to get to know the business.',
          whatsapp: 'The owner mostly wants visitors to message them on WhatsApp.',
          call: 'The owner mostly wants visitors to call them.',
          visit: 'The owner mostly wants visitors to come to the place.',
          book: 'The owner mostly wants visitors to book an appointment.',
        }[goal]
      }\n\n`
    : '';
  const layout = look?.layout && LAYOUTS.find((l) => l.id === look.layout);
  const lookLine = look
    ? `${layout ? `Lay the page out as ${layout.text}. ` : ''}For the look, ${look.tones.length === 1 ? `go with ${look.tones[0]}` : `go with whichever of these suits the business best: ${look.tones.slice(0, -1).join(', ')}, or ${look.tones.at(-1)}`}, on a ${look.dark ? 'dark' : 'light'} background${look.noTicker ? ', without a scrolling ticker or marquee strip' : ''}.\n\n`
    : '';
  // A new design: a complete new page for a business that has one, with the words and photos it has now, that looks different.
  const list = (items: string[]) => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  const now = avoid && [avoid.fonts.length > 0 && `the fonts ${list(avoid.fonts)}`, avoid.colors.length > 0 && `the colors ${list(avoid.colors)}`, avoid.dark !== undefined && `a ${avoid.dark ? 'dark' : 'light'} background`].filter((part): part is string => Boolean(part));
  const different = `${now?.length ? `The current design uses ${list(now)}. ` : ''}Make the new design look very different from the current one: other fonts, other colors, another layout, another kind of hero, other shapes for the sections and cards, unless the owner's request asks to keep something.\n\n`;
  const redesign = instruction
    ? `The business already has a page; the owner wants a new design for it: ${instruction}\n\n${different}${texts?.length ? `Use the texts the page has now:\n${texts.map((text) => `- ${text}`).join('\n')}\n\n` : ''}${keep?.length ? `The owner wrote these texts themselves; keep them word for word:\n${keep.map((text) => `- ${text}`).join('\n')}\n\n` : ''}`
    : '';
  const keepLine = instruction && keepPhotos?.length ? `Keep the owner's photos (${keepPhotos.join(', ')}) on the page. ` : '';
  return `${skill ? `Use the ${skill} skill to create` : 'Create'} a one-page website for this small business, as a single HTML file.

${business}

${redesign}${goalLine}${lookLine}${photosLine}${keepLine}Don't invent facts the owner didn't give.`;
}

/** The reply's HTML document: the last ```html block, or a bare document. */
export function parsePage(text: string): string | undefined {
  const fenced = [...text.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  const html = (fenced ?? /<!doctype html[\s\S]*<\/html>/i.exec(text)?.[0])?.trim();
  return html && html.length > 500 ? html : undefined;
}

/** The API request for a page. */
export function pageParams(request: PageRequest, model: string, effort: PageEffort, skill: PageSkill | null = DEFAULT_PAGE_SKILL, images = false): Anthropic.MessageStreamParams {
  // The photos go first, each after its file name (and what the owner says it shows), so the design can follow them.
  const content: Anthropic.ContentBlockParam[] = [
    ...request.photos.flatMap((p): Anthropic.ContentBlockParam[] => [
      { type: 'text', text: p.caption ? `${p.file}, the owner says: "${p.caption}"` : p.file },
      { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: Buffer.from(p.bytes).toString('base64') } },
    ]),
    { type: 'text', text: pagePrompt(request, skill?.name ?? null, images), cache_control: { type: 'ephemeral' } },
  ];
  // Cached: a make_image round sends all of this again, and reads it at a tenth of the price.
  return {
    model,
    max_tokens: 64000,
    ...(skill && { system: [{ type: 'text', text: skill.text, cache_control: { type: 'ephemeral' } }] }),
    messages: [{ role: 'user', content }],
    ...(images && { tools: [MAKE_IMAGE_TOOL] }),
    ...(takesEffort(model) && { output_config: { effort } }),
  } as Anthropic.MessageStreamParams;
}

/** Tool rounds before the page writer must answer with the page (the image cap itself is MakeImage's). */
const MAX_TOOL_ROUNDS = 6;

/** The count the model reads after each photo. */
const photosLeft = (left: number | undefined) => (left === undefined ? '' : left === 0 ? ' That was the last photo.' : ` ${left} photo${left > 1 ? 's' : ''} left.`);

/**
 * Runs the make_image calls of one reply, together. A failure is a result the model reads, never an exception.
 * `done`: no photos are left.
 */
async function runImageTools(content: Anthropic.ContentBlock[], makeImage: MakeImage): Promise<{ results: Anthropic.ToolResultBlockParam[]; done: boolean }> {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  let done = false;
  const results = await Promise.all(
    calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
      const input = call.input as { description?: unknown; aspect?: unknown };
      const aspect = IMAGE_ASPECTS.includes(input.aspect as ImageAspect) ? (input.aspect as ImageAspect) : '16:9';
      const made: Awaited<ReturnType<MakeImage>> =
        call.name !== MAKE_IMAGE_TOOL.name || typeof input.description !== 'string'
          ? { error: 'unknown tool or no description' }
          : await makeImage({ description: input.description, aspect }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }));
      if (typeof input.description === 'string') console.info('make_image', { scene: input.description, aspect, ...('error' in made ? { error: made.error } : { file: made.file }) });
      // What Opus sent instead of a scene (it once spent 2 minutes of output on calls like this).
      else console.warn('make_image without a scene', { tool: call.name, fields: Object.keys(call.input ?? {}), size: JSON.stringify(call.input ?? {}).length });
      if (made.left === 0) done = true;
      if ('error' in made) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No photo: ${made.error}. Leave this image out of the page.${photosLeft(made.left)}` };
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(made.bytes).toString('base64') } },
          { type: 'text', text: `Saved as ${made.file}.${photosLeft(made.left)}` },
        ],
      };
    }),
  );
  return { results, done };
}

/**
 * The messages with a cache breakpoint on the newest turn's last block, so the next round reads everything before it
 * from the cache. The first request's breakpoint stays (pageParams); the skill has its own: three of the four allowed.
 */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length < 2) return messages;
  const newest = messages.at(-1)!;
  if (typeof newest.content === 'string' || newest.content.length === 0) return messages;
  const content = newest.content.map((block, i, all) => (i === all.length - 1 ? { ...block, cache_control: { type: 'ephemeral' as const } } : block));
  return [...messages.slice(0, -1), { ...newest, content } as Anthropic.MessageParam];
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
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const texts: string[] = []; // every round's text: parsePage takes the last HTML block
    const usage = () => ({
      step: request.current !== undefined ? 'edit_page' : 'write_page',
      modelId: model,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens > 0 && { cacheReadTokens }),
      ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
    });
    for (let round = 0; ; round++) {
      const last = round === MAX_TOOL_ROUNDS;
      const message = await client.messages
        .stream({ ...params, messages: withCacheBreakpoint(messages), ...(last && { tool_choice: { type: 'none' } }) } as Anthropic.MessageStreamParams, { signal })
        .finalMessage();
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      const said = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
      // A page written into a tool call's input, instead of the reply, still counts as the page.
      const inTools = message.content.flatMap((block) => (block.type === 'tool_use' ? Object.values((block.input ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && parsePage(v) !== undefined) : []));
      texts.push(...said, ...inTools);
      // A round that already holds the page ends the job: another round would write it again.
      if (message.stop_reason === 'tool_use' && [...said, ...inTools].some((text) => parsePage(text) !== undefined)) {
        console.warn('page written with a tool call; not running another round', { round });
        return { text: texts.join('\n'), stopReason: 'end_turn', usage: usage() };
      }
      if (message.stop_reason === 'tool_use' && makeImage && !last) {
        const { results, done } = await runImageTools(message.content, makeImage);
        // The tool stays on when the photos are used up: with tool_choice none there, Opus thought briefly and
        // ended with no page, even when told to write it. On the last round it must be off; the line helps.
        const next: Anthropic.ContentBlockParam[] =
          done ? [{ type: 'text', text: 'No photos are left. Write the page now.' }] : round + 1 === MAX_TOOL_ROUNDS ? [{ type: 'text', text: 'Write the page now.' }] : [];
        messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: [...results, ...next] });
        continue;
      }
      return { text: texts.join('\n'), stopReason: message.stop_reason, usage: usage() };
    }
  };
}
