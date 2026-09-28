import { GuardrailBlocked, type CallTool, type ImageInput, type Usage } from './bedrock';
import type { Media, SiteContent } from './content';
import { docMedia, loadDraft, mediaPrefix, ownerText, saveDraft, type SiteDoc } from './drafts';
import type { Job, Stores } from './jobs';
import { checkPage, maskContact, replaceContact } from './page-check';
import { parsePage, pickLook, type PageEffort, type PagePhoto, type PageRequest, type WritePage } from './page-writer';
import { checkContent, PolicyRejection, type Violation } from './policy';
import { isRejected, prescreen } from './prescreen';
import { editContent, planSite } from './site-writer';
import { issueToken, TOKEN_TTL_SECONDS } from './token';
import { processUploads } from './uploads';
import type { Urls } from './urls';

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
  now(): number;
  newDraftId?: () => string;
  /** The page writer: Opus with the frontend-design skill. */
  writePage: WritePage;
  /** For the look nudge (tests pass a fixed one). */
  random?: () => number;
  /** Effort for new pages; edits run one level lower. */
  pageEffort?: PageEffort;
}

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
  await add(media.logo, 'The logo ({{logo}}):');
  for (const [i, photo] of media.photos.entries()) await add(photo, `Photo ${i + 1} ({{photo:${i + 1}}}):`);
  return images;
}

async function pagePhotos(slug: string, media: Media, stores: Stores): Promise<PagePhoto[]> {
  const photos: PagePhoto[] = [];
  const add = async (file: string | undefined, label: string) => {
    if (!file) return;
    const bytes = await stores.getBytes(`${mediaPrefix(slug)}${file}`);
    if (bytes) photos.push({ file, label, bytes, mediaType: file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  };
  await add(media.logo, 'the logo');
  for (const [i, photo] of media.photos.entries()) await add(photo, i === 0 ? 'main photo' : `photo ${i + 1}`);
  return photos;
}

const LOWER: Record<PageEffort, PageEffort> = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: 'low' };

type PageResult = { page: string } | { problem: 'failed' | 'policy' | 'guardrail'; detail: string; violations?: Violation[] };

/** Asks the page writer for a page and runs the page checks and the output guardrail on it. */
async function writeCheckedPage(request: PageRequest, requests: string[], slug: string, deps: GenerateJobDeps, usage: Usage[]): Promise<PageResult> {
  const effort = deps.pageEffort ?? 'high';
  const { answers } = request;
  const masked = maskContact(answers.contact);
  const ask = (photos: PagePhoto[]) =>
    deps.writePage(
      { ...request, photos, answers: { ...answers, contact: masked }, current: request.current && replaceContact(request.current, answers.contact, masked) },
      { effort: request.current !== undefined ? LOWER[effort] : effort },
    );
  let reply;
  try {
    reply = await ask(request.photos).catch((error: unknown) => {
      // A photo the API cannot read fails the request at once: try again without photos rather than lose the page.
      if (request.photos.length > 0 && /image/i.test(String(error))) return ask([]);
      throw error;
    });
  } catch (error) {
    return { problem: 'failed', detail: String(error).slice(0, 300) };
  }
  usage.push(reply.usage);
  const parsed = parsePage(reply.text);
  if (!parsed) return { problem: 'failed', detail: `no HTML page in the reply (stop: ${reply.stopReason})` };
  const page = replaceContact(parsed, masked, answers.contact);
  const checked = checkPage(page, { contact: answers.contact, ownerText: ownerText({ answers, notes: request.notes, requests }), businessName: answers.businessName, lang: answers.lang, ...deps.urls.pageLinks(slug, answers.lang) });
  if (checked.violations.length > 0) return { problem: 'policy', detail: JSON.stringify(checked.violations).slice(0, 300), violations: checked.violations };
  if (!(await deps.outputAllowed(checked.texts.join('\n')))) return { problem: 'guardrail', detail: 'page text' };
  if (checked.repairs.length > 0) console.info('page repaired', { slug, repairs: checked.repairs });
  return { page };
}

/** Every text a visitor can read. */
export function visibleText(content: SiteContent): string {
  return [
    content.businessName, content.title, content.description, content.headline, content.subhead, content.about,
    content.ctaText,
    ...content.services.flatMap((s) => [s.name, s.detail ?? '']),
    ...(content.hours ?? []).flatMap((h) => [h.days, h.time]),
  ].filter(Boolean).join('\n');
}

/**
 * Runs one PENDING job. Clarify stage: the model may ask the owner questions (→ NEEDS_INPUT); the answers
 * route puts the job back to PENDING at the write stage. Write stage: Opus writes the page (or, for an edit,
 * changes the current one) → page checks → output guardrail → new draft (→ DONE). Themed drafts from before
 * the page writer are edited with edit_content. REJECTED on a policy or guardrail stop, FAILED on our error
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
  const finish = (patch: Partial<Job>) => stores.updateJob(jobId, { usage: [...job.usage, ...usage], ...patch });

  let site = await stores.getSite(slug);
  try {
    if (!site) throw new Error(`site ${slug} is gone`);
    let media: Media = job.media ?? { photos: [] };
    let current: SiteDoc | undefined;

    if (kind === 'edit') {
      if (!site.currentDraftId || !job.instruction) throw new Error(`edit job ${jobId} has no draft or no request`);
      current = await loadDraft(slug, site.currentDraftId, stores);
      media = docMedia(current);
      if (stage === 'clarify') {
        const screening = await prescreen(job.answers, { callTool: deps.callTool, modelId: deps.prescreenModelId }, job.instruction);
        usage.push(screening.usage);
        if (isRejected(screening)) {
          await finish({ status: 'REJECTED', rejectedBy: 'prescreen', rejectDetail: screening.category });
          return { outcome: 'REJECTED', ...tokens() };
        }
      }
    } else if (stage === 'clarify' && job.uploadId) {
      // Images first: moderation costs a tenth of a cent, a page costs about 40.
      const processed = await processUploads(job.uploadId, mediaPrefix(slug), deps);
      if (!processed.ok) {
        await releaseNewSite(job, deps);
        await finish({ status: 'REJECTED', rejectedBy: 'image', rejectDetail: processed.reason.slice(0, 300) });
        return { outcome: 'REJECTED', ...tokens() };
      }
      media = processed.media;
    }

    const notes = [...(current?.notes ?? []), ...(job.notes ?? [])];
    if (stage === 'clarify') {
      const plan = await planSite({ answers: job.answers, notes, images: await loadImages(slug, media, stores), photos: media.photos.length, instruction: job.instruction }, deps);
      usage.push(...plan.usage);
      if (plan.questions.length > 0) {
        await finish({ status: 'NEEDS_INPUT', questions: plan.questions, media });
        return { outcome: 'NEEDS_INPUT', ...tokens() };
      }
    }

    let doc: SiteDoc;
    if (current && current.page === undefined) {
      // A themed draft (made before the page writer): the model changes the copy; the theme and brief stay.
      const content = await editContent(current.content!, job.answers, notes, job.instruction!, deps, usage);
      const violations = checkContent(content);
      if (violations.length > 0) throw new PolicyRejection(violations);
      if (!(await deps.outputAllowed(visibleText(content)))) throw new GuardrailBlocked();
      doc = { ...current, content, notes };
    } else {
      // Opus writes the page (a new site), or changes the current one (an edit).
      const photos = await pagePhotos(slug, media, stores);
      const request = current ? { answers: job.answers, notes, photos, current: current.page, instruction: job.instruction } : { answers: job.answers, notes, photos, look: pickLook(deps.random) };
      const requests = [...(current?.requests ?? []), ...(job.instruction ? [job.instruction] : [])];
      const written = await writeCheckedPage(request, requests, slug, deps, usage);
      if ('problem' in written) {
        if (written.problem === 'policy') throw new PolicyRejection(written.violations!);
        if (written.problem === 'guardrail') throw new GuardrailBlocked();
        throw new Error(`page writer failed: ${written.detail}`);
      }
      doc = current ? { ...current, notes, page: written.page, requests } : { answers: job.answers, notes, media, page: written.page };
    }

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
    } else {
      await stores.saveSite({ slug, jobIds: [...new Set([...(site.jobIds ?? []), jobId])] });
    }

    await finish({ status: 'DONE', draftUrl: urls.draftUrl(draftId), media, ownerToken });
    return { outcome: 'DONE', ...tokens() };
  } catch (error) {
    await releaseNewSite(job, deps);
    if (error instanceof PolicyRejection) {
      await finish({ status: 'REJECTED', rejectedBy: 'policy', rejectDetail: error.message.slice(0, 500) });
    } else if (error instanceof GuardrailBlocked) {
      await finish({ status: 'REJECTED', rejectedBy: 'guardrail', rejectDetail: 'generation' });
    } else {
      console.error('generate failed', { jobId, error });
      await finish({ status: 'FAILED', error: String(error).slice(0, 500) });
      return { outcome: 'FAILED', ...tokens() };
    }
    return { outcome: 'REJECTED', ...tokens() };
  }
}

/** A new site that ends without a draft gives its slug and its images back. Edits never do. */
export async function releaseNewSite(job: Job, { stores }: { stores: Stores }): Promise<void> {
  if ((job.kind ?? 'create') !== 'create' || !job.slug) return;
  const site = await stores.getSite(job.slug);
  if (!site || site.currentDraftId || site.jobId !== job.jobId) return;
  await stores.releaseSlug(job.slug, job.jobId);
  await stores.deletePrefix(mediaPrefix(job.slug));
}
