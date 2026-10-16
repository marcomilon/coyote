import { z } from 'zod';
import type { Answers } from './answers';
import { callWithRetry, type CallTool, type ImageInput, type Usage } from './bedrock';
import type { Media } from './content';
import { siteLanguage, type MakeImage, type PagePhoto } from './page-writer';
import { answersBlock, SHARED_RULES } from './prompt';
import type { Note } from './questions';
import { fillSchema, fillTemplate, parseTemplate, StoredFill, type Manifest } from './template';

/**
 * Template mode (`./coyote.sh page-mode template`): a cheap model picks one of the templates Opus designed
 * (`npm run templates:make`) and writes its words; template.ts fills them in. Photos: the owner's first, then
 * photos made for the empty slots (when the owner left "Fotos creadas con IA" on), else the template's drawing.
 */

export interface TemplateInfo {
  id: string;
  /** What the template looks like, for the picker. */
  description: string;
}

/** The templates (`templates/index.json` and `templates/<id>.html` in the page-skills bucket). */
export interface TemplateLibrary {
  list(): Promise<TemplateInfo[]>;
  get(id: string): Promise<string | undefined>;
}

export interface TemplateWriterDeps {
  callTool: CallTool;
  /** The cheap model (Haiku 4.5 on Bedrock). */
  modelId: string;
  templates: TemplateLibrary;
}

export interface TemplateRequest {
  answers: Answers;
  notes: Note[];
  media: Pick<Media, 'logo' | 'photos' | 'captions' | 'generated'>;
  /** The logo and photos as images, so the model can tell which photo fits which slot. */
  photos: PagePhoto[];
  /** Redesigns: the current template and fill, and the owner's change request. */
  current?: { id: string; fill: StoredFill };
  instruction?: string;
  /** Redesigns: texts on the current page that the owner wrote. */
  keep?: string[];
  /** Unset: no photos are made; empty slots keep the template's drawing. */
  makeImage?: MakeImage;
}

export interface TemplatePage {
  page: string;
  template: { id: string; fill: StoredFill };
  /** Photos made for this page. */
  made: string[];
  usage: Usage[];
}

const SYSTEM = `You write the words for one-page websites of small businesses in Latin America. The design is done: a template with named slots. You fill the slots for this business, in the site's language, plainly and warmly, like the business would talk to its customers.

${SHARED_RULES}

Use only facts the owner gave; never invent prices, hours, years in business, awards, reviews or names. When the owner gave little, write fewer, more general words rather than made-up details, and leave optional slots empty when there is nothing true to say.
Never write phone numbers, emails, addresses, prices the owner didn't give, or links: the page adds the owner's contact details itself.
Keep each text within its limit, and close to the length of the template's example.`;

function imageInputs(photos: PagePhoto[]): ImageInput[] {
  return photos.map((p) => ({ label: `${p.file.startsWith('assets/logo') ? 'The logo' : `Photo ${p.file}`}${p.caption ? ` (the owner says it shows: ${p.caption})` : ''}:`, format: p.mediaType === 'image/png' ? 'png' : 'jpeg', bytes: p.bytes }));
}

/**
 * Picks the template. With one template, or a photo change (no instruction), no call is made. A new design gets a
 * template other than the current one, so it looks different.
 */
async function pickTemplate(request: TemplateRequest, catalog: TemplateInfo[], deps: TemplateWriterDeps, usage: Usage[]): Promise<string> {
  const current = request.current && catalog.some((t) => t.id === request.current!.id) ? request.current.id : undefined;
  if (current && !request.instruction) return current;
  const others = catalog.filter((t) => t.id !== current);
  if (others.length === 0) return current!;
  if (others.length === 1) return others[0]!.id;
  catalog = others;
  const ids = catalog.map((t) => t.id);
  const schema = z.object({ id: z.enum(ids as [string, ...string[]]) });
  const picked = await callWithRetry(deps.callTool, usage, {
    modelId: deps.modelId,
    system: `You choose the website template that suits a small business best.\n\n${SHARED_RULES}\nCall the pick_template tool.`,
    guarded: answersBlock(request.answers, request.notes, request.instruction),
    user: `The templates:\n${catalog.map((t) => `- ${t.id}: ${t.description}`).join('\n')}${current ? `\n\nThe page uses another template now; the owner wants a new design that looks different.` : ''}\n\nCall pick_template now.`,
    maxTokens: 300,
    tool: { name: 'pick_template', description: 'Record the template that suits the business best.', schema },
  });
  return picked.id;
}

function fillPrompt(request: TemplateRequest, manifest: Manifest, templateId: string): string {
  const { answers, media } = request;
  const photos = media.photos.map((file) => (media.captions?.[file] ? `${file} ("${media.captions[file]}")` : file));
  const goal = answers.goal && answers.goal !== 'info' ? `The owner mostly wants visitors to ${{ whatsapp: 'message them on WhatsApp', call: 'call them', visit: 'come to the place', book: 'book an appointment' }[answers.goal]}.\n` : '';
  const images =
    manifest.images.length === 0
      ? ''
      : `Photo slots: ${manifest.images.map((i) => `${i.name} (${i.aspect})`).join(', ')}. ${
          photos.length > 0 ? `The owner's photos: ${photos.join(', ')}. Put the owner's photos where they fit best (each one once). ` : 'The owner has no photos. '
        }${request.makeImage ? 'For a slot no owner photo fits, describe a photo to make (scene, in English): the business\'s products, work, tools or place; people only when the scene needs them, ordinary people of the business\'s country.' : 'Leave photo and scene empty for a slot no owner photo fits: the template draws it.'}\n`;
  const current = request.current?.id === templateId ? `\nThe page's current words (keep them, except what the owner's request changes):\n${JSON.stringify(request.current.fill)}\n` : request.current ? `\nThe page's current words, to reuse where they fit:\n${JSON.stringify(request.current.fill)}\n` : '';
  const keep = request.keep?.length ? `\nThe owner wrote these texts themselves; use them word for word where they fit, unless the owner's request asks otherwise:\n${request.keep.map((text) => `- ${text}`).join('\n')}\n` : '';
  return `Language of the site: ${siteLanguage(answers)}.
${goal}${images}${current}${keep}
Call fill_page now, once, with all four parts: texts, lists, images and seo.`;
}

/** Owner photos first (the model's choice, then the rest in order), then made photos for the slots still empty. */
async function slotPhotos(manifest: Manifest, fill: StoredFill, request: TemplateRequest): Promise<{ photos: Record<string, string>; made: string[] }> {
  const photos: Record<string, string> = {};
  const unused = [...request.media.photos];
  for (const slot of manifest.images) {
    const chosen = fill.images[slot.name]?.photo;
    if (chosen && unused.includes(chosen)) {
      photos[slot.name] = chosen;
      unused.splice(unused.indexOf(chosen), 1);
    }
  }
  for (const slot of manifest.images) if (!photos[slot.name] && unused.length > 0) photos[slot.name] = unused.shift()!;
  const made: string[] = [];
  const { makeImage } = request;
  if (makeImage) {
    await Promise.all(
      manifest.images.map(async (slot) => {
        const scene = fill.images[slot.name]?.scene?.trim();
        if (photos[slot.name] || !scene) return;
        // A redesign keeps a made photo whose scene didn't change.
        const earlier = request.current?.fill.images[slot.name];
        if (earlier?.file && earlier.scene?.trim() === scene && request.media.generated?.includes(earlier.file)) {
          photos[slot.name] = earlier.file;
          return;
        }
        const result = await makeImage({ description: scene, aspect: slot.aspect });
        if ('file' in result) {
          photos[slot.name] = result.file;
          made.push(result.file);
        }
      }),
    );
  }
  return { photos, made };
}

/** Picks a template, writes its words, makes the photos, and fills it in. The page still goes through checkPage. */
export async function writeTemplatePage(request: TemplateRequest, deps: TemplateWriterDeps): Promise<TemplatePage> {
  const usage: Usage[] = [];
  const catalog = await deps.templates.list();
  if (catalog.length === 0) throw new Error('no page templates (./coyote.sh page-templates)');
  const id = await pickTemplate(request, catalog, deps, usage);
  const html = await deps.templates.get(id);
  if (!html) throw new Error(`page template ${id} is missing`);
  const manifest = parseTemplate(html);
  if (manifest.errors.length > 0) throw new Error(`page template ${id}: ${manifest.errors.join('; ')}`);

  const value = await callWithRetry(deps.callTool, usage, {
    modelId: deps.modelId,
    system: SYSTEM,
    guarded: answersBlock(request.answers, request.notes, request.instruction),
    user: fillPrompt(request, manifest, id),
    images: imageInputs(request.photos),
    maxTokens: 8000,
    tool: { name: 'fill_page', description: "Record the page's words, its photos, and its search-engine title and description.", schema: fillSchema(manifest) },
  });
  const fill = StoredFill.parse(value);
  const { photos, made } = await slotPhotos(manifest, fill, request);
  for (const [slot, file] of Object.entries(photos)) if (fill.images[slot]) fill.images[slot].file = file;
  const page = fillTemplate(html, fill, { answers: request.answers, media: request.media, photos });
  return { page, template: { id, fill }, made, usage };
}
