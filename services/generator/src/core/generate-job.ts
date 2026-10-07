import { issueLogin, linkSite } from './account';
import { GuardrailBlocked, type CallTool, type ImageInput, type Usage } from './bedrock';
import type { Media } from './content';
import { loadDraft, mediaPrefix, ownerText, saveDraft, type SiteDoc } from './drafts';
import type { Job, Stores } from './jobs';
import { checkPage } from './page-check';
import { parsePage, pickLook, type PageEffort, type PagePhoto, type PageRequest, type WritePage } from './page-writer';
import { PolicyRejection, type Violation } from './policy';
import { isRejected, prescreen } from './prescreen';
import { planSite } from './site-writer';
import { readyEmail, type SendEmail } from './mail';
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
  /** The page writer: Opus (or Haiku, see `pageModel`) with the frontend-design skill. */
  writePage: WritePage;
  /** For the look nudge (tests pass a fixed one). */
  random?: () => number;
  /** Effort for new pages; edits run one level lower. */
  pageEffort?: PageEffort;
  /** The page writer's model ID (page-writer.ts `pageModel`). Unset: the writer's default. */
  pageModel?: string;
  /** The "your site is ready" email. Undefined when no sender is set up. */
  sendEmail?: SendEmail;
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
  const ask = (photos: PagePhoto[]) => deps.writePage({ ...request, photos }, { effort: request.current !== undefined ? LOWER[effort] : effort, model: deps.pageModel });
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
  const page = parsePage(reply.text);
  if (!page) return { problem: 'failed', detail: `no HTML page in the reply (stop: ${reply.stopReason})` };
  const checked = checkPage(page, { contact: answers.contact, ownerText: ownerText({ answers, notes: request.notes, requests }), businessName: answers.businessName, lang: answers.lang, ...deps.urls.pageLinks(slug, answers.lang) });
  if (checked.violations.length > 0) return { problem: 'policy', detail: JSON.stringify(checked.violations).slice(0, 300), violations: checked.violations };
  if (!(await deps.outputAllowed(checked.texts.join('\n')))) return { problem: 'guardrail', detail: 'page text' };
  if (checked.repairs.length > 0) console.info('page repaired', { slug, repairs: checked.repairs });
  return { page };
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
  const finish = (patch: Partial<Job>) => stores.updateJob(jobId, { usage: [...job.usage, ...usage], ...patch });

  let site = await stores.getSite(slug);
  try {
    if (!site) throw new Error(`site ${slug} is gone`);
    let media: Media = job.media ?? { photos: [] };
    let current: SiteDoc | undefined;

    if (kind === 'edit') {
      if (!site.currentDraftId || !job.instruction) throw new Error(`edit job ${jobId} has no draft or no request`);
      current = await loadDraft(slug, site.currentDraftId, stores);
      media = current.media;
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
      // No questions left: the create page tells the owner they may close it (the ready email follows).
      await stores.updateJob(jobId, { stage: 'write' });
    }

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
    const doc: SiteDoc = current ? { ...current, notes, page: written.page, requests } : { answers: job.answers, notes, media, page: written.page };

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
    await finish({ status: 'DONE', draftUrl: urls.draftUrl(draftId), previewUrl, media, ownerToken });
    if (ownerToken && job.ownerEmail) await sendReady(job, slug, deps);
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

/** "Tu sitio está listo", with a sign-in link to "Mis sitios". A failure is logged: the site is there either way. */
async function sendReady(job: Job, slug: string, deps: GenerateJobDeps): Promise<void> {
  if (!deps.sendEmail || !job.ownerEmail) return;
  try {
    const site = await deps.stores.getSite(slug);
    if (!site?.ownerEmailId) return;
    const login = await issueLogin(deps.stores, site.ownerEmailId, deps.now());
    const { lang, businessName } = job.answers;
    await deps.sendEmail(readyEmail(job.ownerEmail, lang, businessName, deps.urls.mySitesUrl(login, lang, slug)));
  } catch (error) {
    console.error('ready email failed', { slug, error });
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
