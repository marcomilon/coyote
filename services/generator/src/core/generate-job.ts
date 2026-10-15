import { issueLogin, linkSite } from './account';
import { claimFreeDraft, returnFreeDraft } from './free-draft';
import { noteRedesignDone } from './chat-notes';
import { GuardrailBlocked, type CallTool, type ImageInput, type Usage } from './bedrock';
import type { Media } from './content';
import { loadDraft, mediaPrefix, ownerText, saveDraft, type SiteDoc } from './drafts';
import { voiceOf } from './i18n';
import { imageMaker, imageRatio, madeRatio, type GenerateImage } from './images';
import type { Job, Stores } from './jobs';
import { checkPage } from './page-check';
import { DEFAULT_PAGE_MODEL, DEFAULT_PAGE_SKILL, NO_SKILL, parsePage, pickLook, type PageEffort, type PagePhoto, type PageSkill, type PageRequest, type WritePage } from './page-writer';
import { PolicyRejection, type Violation } from './policy';
import { isRejected, prescreen } from './prescreen';
import { planSite } from './site-writer';
import { writeTemplatePage, type TemplateLibrary } from './template-writer';
import { readyEmail, type SendEmail } from './mail';
import { issueToken, TOKEN_TTL_SECONDS } from './token';
import { mergeMedia, processUploads } from './uploads';
import type { Urls } from './urls';
import { announceEdit, announceFailure, announceNewSite, announceRejection, type Announce, type OwnerTextsCount, type PageWriterStatus } from './notices';
import { escapeHtml } from './html';
import { restoreTexts } from './page-texts';

export interface GenerateJobDeps {
  stores: Stores;
  callTool: CallTool;
  /** Writes the sites. */
  modelId: string;
  /** Screens edit requests (the form is screened in submit). */
  prescreenModelId: string;
  urls: Urls;
  /** Output guardrail on the visible text. Resolves to true when it may be shown. */
  outputAllowed(text: string): Promise<boolean>;
  /** Image moderation. Resolves to the labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
  /** Names uploaded files (uploads.ts); tests pass a fixed one. */
  newFileId?: () => string;
  /** The words legible in a made photo (images.ts). Unset: not checked. */
  readText?(key: string): Promise<string[]>;
  now(): number;
  newDraftId?: () => string;
  /** The page writer: Opus (or Haiku, see `pageModel`) with a skill (see `pageSkill`). */
  writePage: WritePage;
  /** For the look nudge (tests pass a fixed one). */
  random?: () => number;
  /** Effort for new pages; edits run one level lower. */
  pageEffort?: PageEffort;
  /** The page writer's model ID (page-writer.ts `pageModel`). Unset: the writer's default. */
  pageModel?: string;
  /** The page writer's skill (`./coyote.sh page-skill`); null: none. Unset: the writer's default. */
  pageSkill?: PageSkill | null;
  /**
   * How pages are made (`./coyote.sh page-mode`): `design`, Opus writes each page; `template`, the cheap model
   * (`modelId`) fills a template from `templates`. Unset: design.
   */
  pageMode?: PageMode;
  templates?: TemplateLibrary;
  /** The look nudge on new sites (`./coyote.sh page-look`). Unset: on. */
  pageLook?: boolean;
  /**
   * Photos the page writer makes, for owners who left "Fotos creadas con IA" on: the text-to-image model, and the
   * stack-wide switch (`./coyote.sh page-images`; unset: on). No generateImage: no photos.
   */
  generateImage?: GenerateImage;
  imageModelId?: string;
  pageImages?: boolean;
  /** The "your site is ready" email. Undefined when no sender is set up. */
  sendEmail?: SendEmail;
  /** Notices for the admin (notices.ts). Undefined: nobody is told. */
  announce?: Announce;
}

export const PAGE_MODES = ['design', 'template'] as const;
export type PageMode = (typeof PAGE_MODES)[number];

export type GenerateOutcome =
  | { outcome: 'SKIPPED' }
  | { outcome: 'NEEDS_INPUT' | 'DONE' | 'REJECTED' | 'FAILED'; tokensIn: number; tokensOut: number };

async function loadImages(slug: string, media: Media, stores: Stores): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  const add = async (path: string | undefined, label: string) => {
    if (!path) return;
    const bytes = await stores.getBytes(`${mediaPrefix(slug)}${path}`);
    if (bytes) images.push({ label, format: path.endsWith('.png') ? 'png' : 'jpeg', bytes });
  };
  await add(media.logo, 'The logo:');
  for (const [i, photo] of media.photos.entries()) await add(photo, `Photo ${i + 1}${media.captions?.[photo] ? ` (the owner says it shows: ${media.captions[photo]})` : ''}:`);
  return images;
}

async function pagePhotos(slug: string, media: Media, stores: Stores): Promise<PagePhoto[]> {
  const photos: PagePhoto[] = [];
  const add = async (file: string | undefined, caption?: string) => {
    if (!file) return;
    const bytes = await stores.getBytes(`${mediaPrefix(slug)}${file}`);
    if (bytes) photos.push({ file, ...(caption && { caption }), bytes, mediaType: file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  };
  await add(media.logo);
  for (const photo of media.photos) await add(photo, media.captions?.[photo]);
  return photos;
}

/** The page writer's request for photos the owner added or took out in Mi sitio. */
export function photoInstruction({ added, removed, described = [] }: { added: string[]; removed: string[]; described?: string[] }, media: Media): string {
  const logo = added.find((file) => file === media.logo);
  const photos = added.filter((file) => file !== logo);
  const said = (file: string) => (media.captions?.[file] ? ` ("${media.captions[file]}")` : '');
  return [
    logo && `Use the owner's new logo (${logo}) in place of the current one.`,
    photos.length > 0 && `The owner added ${photos.length === 1 ? `a photo of the business: ${photos[0]}${said(photos[0]!)}.` : `photos of the business: ${photos.map((file) => file + said(file)).join(', ')}.`} Use ${photos.length === 1 ? 'it' : 'them'} where ${photos.length === 1 ? 'it fits' : 'they fit'} best, in place of made photos or drawings where that suits the page.`,
    described.length > 0 && `The owner described ${described.map((file) => (media.captions?.[file] ? `${file} as "${media.captions[file]}"` : `${file} as nothing in particular`)).join(', ')}: place ${described.length === 1 ? 'it' : 'them'} to match.`,
    removed.length > 0 && `The owner took out ${removed.join(', ')}: remove ${removed.length === 1 ? 'it' : 'them'} from the page.`,
  ]
    .filter(Boolean)
    .join(' ');
}

const LOWER: Record<PageEffort, PageEffort> = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: 'low' };

type PageResult = { page: string; made: string[]; template?: SiteDoc['template']; ownerTexts?: string[] } | { problem: 'failed' | 'policy' | 'guardrail'; detail: string; violations?: Violation[] };

/** Asks the page writer for a page and runs the page checks and the output guardrail on it. */
async function writeCheckedPage(request: PageRequest, requests: string[], slug: string, deps: GenerateJobDeps, usage: Usage[]): Promise<PageResult> {
  const effort = deps.pageEffort ?? 'high';
  const { answers } = request;
  const made: string[] = [];
  const images = answers.aiImages === true && deps.pageImages !== false && deps.generateImage;
  const makeImage = images ? imageMaker(mediaPrefix(slug), { ...deps, generateImage: images }, made) : undefined;
  const ask = (photos: PagePhoto[]) =>
    deps.writePage({ ...request, photos }, { effort: request.current !== undefined ? LOWER[effort] : effort, model: deps.pageModel, ...(deps.pageSkill !== undefined && { skill: deps.pageSkill }), ...(makeImage && { makeImage }) });
  let reply;
  try {
    reply = await ask(request.photos).catch((error: unknown) => {
      // A photo the API cannot read fails the request at once: try again without photos rather than lose the page.
      if (request.photos.length > 0 && /image/i.test(String(error))) return ask([]);
      throw error;
    });
  } catch (error) {
    return { problem: 'failed', detail: String(error).slice(0, 300) };
  } finally {
    usage.push(...made.map(() => ({ step: 'make_image', modelId: deps.imageModelId ?? 'image', inputTokens: 0, outputTokens: 0 })));
  }
  usage.push(reply.usage);
  const page = parsePage(reply.text);
  if (!page) return { problem: 'failed', detail: `no HTML page in the reply (stop: ${reply.stopReason})` };
  return checkWrittenPage(page, made, request, requests, slug, deps);
}

/** The page checks and the output guardrail, for a page from either mode. */
async function checkWrittenPage(page: string, made: string[], request: Pick<PageRequest, 'answers' | 'notes' | 'photos'>, requests: string[], slug: string, deps: GenerateJobDeps): Promise<PageResult> {
  const { answers } = request;
  const checked = checkPage(page, { contact: answers.contact, ownerText: ownerText({ answers, notes: request.notes, requests, media: { captions: Object.fromEntries(request.photos.flatMap((p) => (p.caption ? [[p.file, p.caption]] : []))) } }), businessName: answers.businessName, lang: answers.lang, ...deps.urls.pageLinks(slug, answers.lang) });
  if (checked.violations.length > 0) return { problem: 'policy', detail: JSON.stringify(checked.violations).slice(0, 300), violations: checked.violations };
  if (!(await deps.outputAllowed(checked.texts.join('\n')))) return { problem: 'guardrail', detail: 'page text' };
  if (checked.repairs.length > 0) console.info('page repaired', { slug, repairs: checked.repairs });
  return { page, made };
}

/**
 * Each made photo's file gives way to the owner's photo in the page (img src, srcset, CSS backgrounds), and an
 * image showing it takes the photo's description as its alt text when the owner gave one.
 */
export function swapMadePhotos(page: string, swaps: { made: string; photo: string }[], captions: Record<string, string> = {}): string {
  let out = page;
  for (const { made, photo } of swaps) {
    out = out.split(made).join(photo);
    const caption = captions[photo];
    if (caption) out = out.replace(new RegExp(`<img\\b[^>]*${photo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'g'), (tag) => tag.replace(/\balt\s*=\s*("[^"]*"|'[^']*')/i, `alt="${escapeHtml(caption)}"`));
  }
  return out;
}

const ABOUT_PHOTOS = /\b(fotos?|im[aá]gen(es)?|photos?|imagens?|logo)\b/i;
const MADE_FILE = /assets\/gen-[\w-]+\.\w+/g;

/** Two shapes close enough that one photo fills the other's frame without a bad crop (4:3 into 3:2 or 1:1, not into 16:9 from portrait). */
const SAME_SHAPE = 1.35;

/**
 * After a redesign: the owner's photos the page showed, and the owner didn't take out, that the new page left out
 * go back in place of photos the page writer made of a similar shape (this redesign's first). `ratios`: width over
 * height of the owner's photos; one with no known shape stays out. A request about photos is left to the writer.
 * `lost`: left out with no made photo of its shape to replace.
 */
export function restorePhotos(before: string, after: string, photos: string[], made: string[], instruction: string, ratios: Record<string, number>, captions: Record<string, string> = {}) {
  const shown = photos.filter((file) => before.includes(file));
  const missing = shown.filter((file) => !after.includes(file));
  const none = { page: after, kept: shown.length - missing.length, restored: [] as string[], lost: missing };
  if (missing.length === 0 || ABOUT_PHOTOS.test(instruction)) return none;
  const free = [...new Set([...made, ...(after.match(MADE_FILE) ?? [])])].filter((file) => after.includes(file));
  const swaps: { made: string; photo: string }[] = [];
  for (const photo of missing) {
    const ratio = ratios[photo];
    const fit = ratio && free.find((file) => {
      const frame = madeRatio(file);
      return frame !== undefined && Math.max(frame, ratio) / Math.min(frame, ratio) <= SAME_SHAPE;
    });
    if (!fit) continue;
    free.splice(free.indexOf(fit), 1);
    swaps.push({ made: fit, photo });
  }
  const restored = swaps.map((s) => s.photo);
  return { page: swapMadePhotos(after, swaps, captions), kept: none.kept, restored, lost: missing.filter((file) => !restored.includes(file)) };
}

/** Width over height of the owner's photos, read from their files. */
async function photoRatios(slug: string, files: string[], stores: GenerateJobDeps['stores']): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const file of files) {
    const bytes = await stores.getBytes(`${mediaPrefix(slug)}${file}`).catch(() => undefined);
    const ratio = bytes && imageRatio(bytes);
    if (ratio) out[file] = ratio;
  }
  return out;
}

/** A swap of made photos for the owner's: the same page with the new files, the usual checks, and the template's record of its photos. */
async function swapCheckedPage(current: SiteDoc, swaps: { made: string; photo: string }[], media: Media, request: PageRequest, requests: string[], slug: string, deps: GenerateJobDeps): Promise<PageResult> {
  const checked = await checkWrittenPage(swapMadePhotos(current.page, swaps, media.captions), [], request, requests, slug, deps);
  if ('problem' in checked || !current.template) return checked;
  const photoFor = new Map(swaps.map((s) => [s.made, s.photo]));
  const images = Object.fromEntries(Object.entries(current.template.fill.images).map(([slot, choice]) => [slot, choice.file && photoFor.has(choice.file) ? { ...choice, file: photoFor.get(choice.file) } : choice]));
  return { ...checked, template: { ...current.template, fill: { ...current.template.fill, images } } };
}

/** Template mode: the cheap model picks a template and writes its words; then the same checks as a written page. */
async function fillCheckedPage(request: PageRequest, media: Media, current: SiteDoc | undefined, requests: string[], slug: string, deps: GenerateJobDeps, usage: Usage[]): Promise<PageResult> {
  if (!deps.templates) return { problem: 'failed', detail: 'template mode without a template library' };
  const { answers } = request;
  const made: string[] = [];
  const images = answers.aiImages === true && deps.pageImages !== false && deps.generateImage;
  const makeImage = images ? imageMaker(mediaPrefix(slug), { ...deps, generateImage: images }, made) : undefined;
  let written;
  try {
    written = await writeTemplatePage(
      { answers, notes: request.notes, media, photos: request.photos, ...(current?.template && { current: current.template }), ...(request.instruction && { instruction: request.instruction }), ...(request.keep && { keep: request.keep }), ...(makeImage && { makeImage }) },
      { callTool: deps.callTool, modelId: deps.modelId, templates: deps.templates },
    );
  } catch (error) {
    if (error instanceof GuardrailBlocked) return { problem: 'guardrail', detail: 'template words' };
    return { problem: 'failed', detail: String(error).slice(0, 300) };
  } finally {
    usage.push(...made.map(() => ({ step: 'make_image', modelId: deps.imageModelId ?? 'image', inputTokens: 0, outputTokens: 0 })));
  }
  usage.push(...written.usage);
  const checked = await checkWrittenPage(written.page, written.made, request, requests, slug, deps);
  return 'problem' in checked ? checked : { ...checked, template: written.template };
}

/**
 * Runs one PENDING job. Clarify stage: the model may ask the owner questions (→ NEEDS_INPUT); the answers
 * route puts the job back to PENDING at the write stage. Write stage: Opus writes the page (or, for an edit,
 * changes the current one) → page checks → output guardrail → new draft (→ DONE). REJECTED on a policy or guardrail stop, FAILED on our error
 * (the page writer failing included). A new site that never got a draft gives its slug back; an edit never touches the slug.
 */
export async function runGenerateJob(jobId: string, deps: GenerateJobDeps): Promise<GenerateOutcome> {
  const { stores, urls } = deps;
  const job = await stores.getJob(jobId);
  if (!job || job.status !== 'PENDING' || !job.slug) return { outcome: 'SKIPPED' };
  const slug = job.slug;
  const kind = job.kind ?? 'create';
  const stage = job.stage ?? 'clarify';
  const usage: Usage[] = [];
  const tokens = () => ({ tokensIn: usage.reduce((n, u) => n + u.inputTokens, 0), tokensOut: usage.reduce((n, u) => n + u.outputTokens, 0) });
  const finish = async (patch: Partial<Job>, draftId?: string) => {
    await stores.updateJob(jobId, { usage: [...job.usage, ...usage], ...patch });
    // A redesign from the chat: its note there says how it ended.
    if (patch.status === 'DONE' || patch.status === 'REJECTED' || patch.status === 'FAILED') await noteRedesignDone(stores, job, patch.status, draftId);
  };

  let site = await stores.getSite(slug);
  try {
    if (!site) throw new Error(`site ${slug} is gone`);
    let media: Media = job.media ?? { photos: [] };
    let current: SiteDoc | undefined;

    let photoChange = job.photoChange;
    if (kind === 'edit') {
      const photosChanged = Boolean(job.uploadId || job.removePhotos?.length || job.captions);
      if (!site.currentDraftId || !(job.instruction || photoChange || photosChanged)) throw new Error(`edit job ${jobId} has no draft or no request`);
      current = await loadDraft(slug, site.currentDraftId, stores);
      media = job.media ?? current.media;
      // The owner's words: the request and the photo descriptions.
      const screened = [job.instruction, ...Object.values(job.captions ?? {}), ...(job.newCaptions ?? [])].filter(Boolean).join('\n');
      if (stage === 'clarify' && screened) {
        const screening = await prescreen(job.answers, { callTool: deps.callTool, modelId: deps.prescreenModelId }, screened);
        usage.push(screening.usage);
        if (isRejected(screening)) {
          await finish({ status: 'REJECTED', rejectedBy: 'prescreen', rejectDetail: screening.category });
          await announceRejection(deps.announce, job, 'prescreen', screening.category, usage);
          return { outcome: 'REJECTED', ...tokens() };
        }
      }
      if (stage === 'clarify' && photosChanged) {
        // Photos added, taken out, or described in Mi sitio: moderated like a new site's, and the site keeps its last version if refused.
        const none: Media = { photos: [] };
        const processed = job.uploadId ? await processUploads(job.uploadId, mediaPrefix(slug), deps, job.newCaptions) : { ok: true as const, media: none };
        if (!processed.ok) {
          await finish({ status: 'REJECTED', rejectedBy: 'image', rejectDetail: processed.reason.slice(0, 300) });
          await announceRejection(deps.announce, job, 'image', processed.reason.slice(0, 300), usage);
          return { outcome: 'REJECTED', ...tokens() };
        }
        const removed = (job.removePhotos ?? []).filter((file) => file === current!.media.logo || current!.media.photos.includes(file));
        media = mergeMedia(current.media, processed.media, removed, job.captions);
        const described = Object.keys(job.captions ?? {}).filter((file) => media.photos.includes(file));
        const replaced = job.replaceMade?.slice(0, processed.media.photos.length);
        photoChange = { added: [processed.media.logo, ...processed.media.photos].filter((f): f is string => !!f), removed, ...(described.length > 0 && { described }), ...(replaced?.length && { replaced }) };
        await stores.updateJob(jobId, { media, photoChange });
      }
    } else if (stage === 'clarify' && job.uploadId) {
      // Images first: moderation costs a tenth of a cent, a page costs about 40.
      const processed = await processUploads(job.uploadId, mediaPrefix(slug), deps, job.answers.photoNotes);
      if (!processed.ok) {
        await releaseNewSite(job, deps);
        await finish({ status: 'REJECTED', rejectedBy: 'image', rejectDetail: processed.reason.slice(0, 300) });
        await announceRejection(deps.announce, job, 'image', processed.reason.slice(0, 300), usage);
        return { outcome: 'REJECTED', ...tokens() };
      }
      media = processed.media;
    }
    // What the page writer is asked to change: the owner's words, then the photo change.
    const instruction = [job.instruction, photoChange && photoInstruction(photoChange, media)].filter(Boolean).join(' ') || undefined;

    const notes = [...(current?.notes ?? []), ...(job.notes ?? [])];
    // A photo change alone needs no questions.
    if (stage === 'clarify' && (kind === 'create' || job.instruction)) {
      const plan = await planSite({ answers: job.answers, notes, images: await loadImages(slug, media, stores), photos: media.photos.length, instruction }, deps);
      usage.push(...plan.usage);
      if (plan.questions.length > 0) {
        await finish({ status: 'NEEDS_INPUT', questions: plan.questions, requiredQuestion: plan.required, media });
        return { outcome: 'NEEDS_INPUT', ...tokens() };
      }
      // No questions left: the create page tells the owner they may close it (the ready email follows).
      await stores.updateJob(jobId, { stage: 'write' });
    }

    // A new site uses the email's free draft, claimed atomically right before the page model runs.
    if (kind === 'create' && job.ownerEmail && !job.freeDraft) {
      if (!(await claimFreeDraft(stores, job.ownerEmail, deps.now()))) {
        await releaseNewSite(job, deps);
        await finish({ status: 'REJECTED', rejectedBy: 'limit' });
        return { outcome: 'REJECTED', ...tokens() };
      }
      job.freeDraft = true;
      await stores.updateJob(jobId, { freeDraft: true });
    }

    // Opus writes the page (a new site), or changes the current one (an edit).
    const photos = await pagePhotos(slug, media, stores);
    const goal = job.answers.goal && { goal: job.answers.goal };
    const keep = current?.ownerTexts?.length ? current.ownerTexts : undefined;
    // The owner's photos the page shows (taken-out ones are no longer in media).
    const keepPhotos = current ? media.photos.filter((file) => current!.page.includes(file)) : [];
    const request = current
      ? { answers: job.answers, notes, photos, ...goal, current: current.page, instruction, ...(keep && { keep }), ...(keepPhotos.length > 0 && { keepPhotos }) }
      : { answers: job.answers, notes, photos, ...goal, ...(deps.pageLook !== false && { look: pickLook(deps.random) }) };
    const requests = [...(current?.requests ?? []), ...(job.instruction ? [job.instruction] : [])];
    // The owner's photos in place of made ones: swapped in the page, with no page writer.
    const swaps = current && photoChange?.replaced?.length ? photoChange.replaced.map((made, i) => ({ made, photo: photoChange!.added[i]! })) : undefined;
    const written = swaps
      ? await swapCheckedPage(current!, swaps, media, request, requests, slug, deps)
      : deps.pageMode === 'template'
        ? await fillCheckedPage(request, media, current, requests, slug, deps, usage)
        : await writeCheckedPage(request, requests, slug, deps, usage);
    if ('problem' in written) {
      if (written.problem === 'policy') throw new PolicyRejection(written.violations!);
      if (written.problem === 'guardrail') throw new GuardrailBlocked();
      throw new Error(`page writer failed: ${written.detail}`);
    }
    // The texts the owner wrote: the ones the new page reworded go back (unless the request asked for it).
    let ownerTexts: OwnerTextsCount | undefined;
    if (current && keep) {
      let restored = restoreTexts(current.page, written.page, keep, job.instruction ?? '', job.answers.contact);
      // Texts that passed on the earlier page; checked again all the same.
      if (restored.restored.length > 0 && 'problem' in (await checkWrittenPage(restored.page, written.made, request, requests, slug, deps))) {
        console.warn('owner texts not restored', { slug });
        restored = { page: written.page, kept: restored.kept.filter((text) => !restored.restored.includes(text)), restored: [], lost: [...restored.lost, ...restored.restored] };
      }
      written.page = restored.page;
      written.ownerTexts = restored.kept;
      ownerTexts = { kept: restored.kept.length - restored.restored.length, restored: restored.restored.length, lost: restored.lost.length };
    }
    // The owner's photos: the ones the new page left out go back in place of made photos.
    let ownerPhotos: OwnerTextsCount | undefined;
    if (current && keepPhotos.length > 0 && !swaps) {
      const ratios = await photoRatios(slug, keepPhotos.filter((file) => !written.page.includes(file)), stores);
      let back = restorePhotos(current.page, written.page, keepPhotos, written.made, job.instruction ?? '', ratios, media.captions);
      if (back.restored.length > 0 && 'problem' in (await checkWrittenPage(back.page, written.made, request, requests, slug, deps))) {
        console.warn('owner photos not restored', { slug });
        back = { page: written.page, kept: back.kept, restored: [], lost: [...back.lost, ...back.restored] };
      }
      written.page = back.page;
      ownerPhotos = { kept: back.kept, restored: back.restored.length, lost: back.lost.length };
    }
    // The made photos the page uses, with the earlier ones it still uses (an edit keeps its page's photos).
    const generated = [...new Set([...(media.generated ?? []), ...written.made])].filter((file) => written.page.includes(file)).slice(-8);
    const { generated: _earlier, ...files } = media;
    media = generated.length > 0 ? { ...files, generated } : files;
    // The form's photo descriptions live on as media.captions, which Tus fotos keeps up to date.
    const { photoNotes: _notes, ...answers } = job.answers;
    // The template and its words, for the next template redesign (an Opus edit keeps the earlier ones).
    const template = written.template ?? current?.template;
    const doc: SiteDoc = { ...(current ? { ...current, requests } : { answers }), notes, media, page: written.page, ...(template && { template }), ...(written.ownerTexts && { ownerTexts: written.ownerTexts }) };

    const draftId = await saveDraft(site, doc, deps);
    site = (await stores.getSite(slug)) ?? site;

    // A new site's first draft: the site becomes the owner's, and the magic link is issued (shown once).
    let ownerToken: string | undefined;
    if (kind === 'create' && !site.tokenHash) {
      const issued = issueToken(slug);
      ownerToken = issued.token;
      await stores.saveSite({
        slug,
        status: 'draft',
        ownerWhatsApp: job.answers.contact.whatsapp,
        tokenHash: issued.tokenHash,
        tokenExpiresAt: Math.floor(deps.now() / 1000) + TOKEN_TTL_SECONDS,
        jobIds: [...new Set([...(site.jobIds ?? []), jobId])],
      });
      if (job.ownerEmail) await linkSite(stores, job.ownerEmail, job.answers.lang, { slug, businessName: job.answers.businessName, createdAt: site.createdAt });
    } else {
      await stores.saveSite({ slug, jobIds: [...new Set([...(site.jobIds ?? []), jobId])] });
    }

    const previewUrl = site.previewId ? urls.draftUrl(site.previewId) : undefined;
    await finish({ status: 'DONE', draftUrl: urls.draftUrl(draftId), previewUrl, media, ownerToken }, draftId);
    if (ownerToken && job.ownerEmail) await sendReady(job, slug, deps);
    if (ownerToken) await announceNewSite(deps.announce, job, slug, deps.urls.draftUrl(draftId), usage, pageWriterStatus(job, deps, doc.template?.id));
    else if (kind === 'edit') await announceEdit(deps.announce, { ...job, photoChange }, slug, deps.urls.draftUrl(draftId), usage, pageWriterStatus(job, deps, written.template?.id), ownerTexts, ownerPhotos);
    return { outcome: 'DONE', ...tokens() };
  } catch (error) {
    await releaseNewSite(job, deps);
    if (error instanceof PolicyRejection) {
      await finish({ status: 'REJECTED', rejectedBy: 'policy', rejectDetail: error.message.slice(0, 500) });
      await announceRejection(deps.announce, job, 'policy', error.message.slice(0, 500), usage);
    } else if (error instanceof GuardrailBlocked) {
      await finish({ status: 'REJECTED', rejectedBy: 'guardrail', rejectDetail: 'generation' });
      await announceRejection(deps.announce, job, 'guardrail', 'generation', usage);
    } else {
      console.error('generate failed', { jobId, error });
      if (job.freeDraft && job.ownerEmail) await returnFreeDraft(stores, job.ownerEmail);
      await finish({ status: 'FAILED', error: String(error).slice(0, 500) });
      await announceFailure(deps.announce, job, String(error), usage);
      return { outcome: 'FAILED', ...tokens() };
    }
    return { outcome: 'REJECTED', ...tokens() };
  }
}

/** The page writer's settings this job ran with (for the admin notice). */
function pageWriterStatus(job: Job, deps: GenerateJobDeps, template?: string): PageWriterStatus {
  return {
    ...(deps.pageMode === 'template' && template && { template }),
    model: deps.pageMode === 'template' ? deps.modelId : (deps.pageModel ?? DEFAULT_PAGE_MODEL),
    effort: deps.pageEffort ?? 'high',
    skill: deps.pageSkill === undefined ? DEFAULT_PAGE_SKILL.name : (deps.pageSkill?.name ?? NO_SKILL),
    look: deps.pageLook !== false,
    images: deps.pageImages !== false && !!deps.generateImage,
    ownerImages: job.answers.aiImages === true,
  };
}

/** "Tu página web está lista", with a sign-in link to "Mis páginas web". A failure is logged: the site is there either way. */
async function sendReady(job: Job, slug: string, deps: GenerateJobDeps): Promise<void> {
  if (!deps.sendEmail || !job.ownerEmail) return;
  try {
    const site = await deps.stores.getSite(slug);
    if (!site?.ownerEmailId) return;
    const login = await issueLogin(deps.stores, site.ownerEmailId, deps.now());
    const { lang, businessName } = job.answers;
    await deps.sendEmail(readyEmail(job.ownerEmail, voiceOf(job.answers), businessName, deps.urls.mySitesUrl(login, lang, slug), deps.urls.appUrl));
  } catch (error) {
    console.error('ready email failed', { slug, error });
  }
}

/**
 * The generate Lambda's on-failure destination: a timeout or crash that runGenerateJob could not record itself.
 * The job becomes FAILED (a new site gives its slug back) and the admin hears of it, with the cost recorded so far.
 */
export async function recordGenerateCrash(jobId: string, errorMessage: string | undefined, deps: { stores: Stores; announce?: Announce }): Promise<void> {
  const { stores } = deps;
  const job = await stores.getJob(jobId);
  if (!job || job.status !== 'PENDING') return;
  const error = (errorMessage ?? 'generate crashed').slice(0, 500);
  await releaseNewSite(job, deps);
  if (job.freeDraft && job.ownerEmail) await returnFreeDraft(stores, job.ownerEmail);
  await stores.updateJob(jobId, { status: 'FAILED', error });
  await noteRedesignDone(stores, job, 'FAILED');
  await announceFailure(deps.announce, job, error, [], /timed out/i.test(error));
}

/** A new site that ends without a draft gives its slug and its images back. Edits never do. */
export async function releaseNewSite(job: Job, { stores }: { stores: Stores }): Promise<void> {
  if ((job.kind ?? 'create') !== 'create' || !job.slug) return;
  const site = await stores.getSite(job.slug);
  if (!site || site.currentDraftId || site.jobId !== job.jobId) return;
  await stores.releaseSlug(job.slug, job.jobId);
  await stores.deletePrefix(mediaPrefix(job.slug));
}
