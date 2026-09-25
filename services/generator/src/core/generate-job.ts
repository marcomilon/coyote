import { GuardrailBlocked, type CallText, type CallTool, type ImageInput, type Usage } from './bedrock';
import type { Media } from './content';
import { loadDraft, mediaPrefix, saveDraft, type SiteDoc } from './drafts';
import type { Job, Stores } from './jobs';
import { generateHero, type GenerateImage } from './images';
import { PolicyRejection } from './policy';
import { isRejected, prescreen } from './prescreen';
import { planSite, writeSite, type SiteInput } from './site-writer';
import { issueToken, TOKEN_TTL_SECONDS } from './token';
import { processUploads } from './uploads';
import type { Urls } from './urls';

export interface GenerateJobDeps {
  stores: Stores;
  callTool: CallTool;
  /** The page itself comes back as plain text. */
  callText: CallText;
  /** Writes the sites. */
  modelId: string;
  /** Screens edit requests (the form is screened in submit). */
  prescreenModelId: string;
  urls: Urls;
  /** Output guardrail on the visible text. Resolves to true when it may be shown. */
  outputAllowed(text: string): Promise<boolean>;
  /** Image moderation. Resolves to the labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
  /** Hero photo for sites with no uploaded photos. Absent when the feature is off. */
  generateImage?: GenerateImage;
  imageModelId?: string;
  now(): number;
  newDraftId?: () => string;
}

export type GenerateOutcome =
  | { outcome: 'SKIPPED' }
  | { outcome: 'NEEDS_INPUT' | 'DONE' | 'REJECTED' | 'FAILED'; tokensIn: number; tokensOut: number; heroImages?: number };

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

/**
 * Runs one PENDING job. Clarify stage: the model may ask the owner questions (→ NEEDS_INPUT); the answers
 * route puts the job back to PENDING at the write stage. Write stage: page → sanitizer and text checks →
 * output guardrail → hero photo → fill → new draft (→ DONE). REJECTED on a policy or guardrail stop, FAILED
 * on our error. A new site that never got a draft gives its slug back; an edit never touches the slug.
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
    let current: { source: string; doc: SiteDoc } | undefined;

    if (kind === 'edit') {
      if (!site.currentDraftId) throw new Error(`site ${slug} has no draft to edit`);
      current = await loadDraft(slug, site.currentDraftId, stores);
      media = current.doc.media;
      if (stage === 'clarify') {
        const screening = await prescreen(job.answers, { callTool: deps.callTool, modelId: deps.prescreenModelId }, job.instruction);
        usage.push(screening.usage);
        if (isRejected(screening)) {
          await finish({ status: 'REJECTED', rejectedBy: 'prescreen', rejectDetail: screening.category });
          return { outcome: 'REJECTED', ...tokens() };
        }
      }
    } else if (stage === 'clarify' && job.uploadId) {
      // Images first: moderation costs a tenth of a cent, a page costs far more.
      const processed = await processUploads(job.uploadId, mediaPrefix(slug), deps);
      if (!processed.ok) {
        await releaseNewSite(job, deps);
        await finish({ status: 'REJECTED', rejectedBy: 'image', rejectDetail: processed.reason.slice(0, 300) });
        return { outcome: 'REJECTED', ...tokens() };
      }
      media = processed.media;
    }

    const input: SiteInput = {
      answers: job.answers,
      notes: [...(current?.doc.notes ?? []), ...(job.notes ?? [])],
      media,
      images: await loadImages(slug, media, stores),
      instruction: job.instruction,
      current: current?.source,
    };

    if (stage === 'clarify') {
      const plan = await planSite(input, deps);
      usage.push(...plan.usage);
      if (plan.questions.length > 0) {
        await finish({ status: 'NEEDS_INPUT', questions: plan.questions, media });
        return { outcome: 'NEEDS_INPUT', ...tokens() };
      }
    }

    const written = await writeSite(input, deps, usage);
    if (!(await deps.outputAllowed([written.text.title, ...written.text.texts].join('\n')))) throw new GuardrailBlocked();

    // Only once the text has passed every check, so a rejected request costs no image.
    // Counted per attempt: the image model bills per request, whatever moderation decides afterwards.
    let heroImages = 0;
    if (kind === 'create' && media.photos.length === 0 && written.heroScene && written.source.includes('{{hero}}') && deps.generateImage) {
      heroImages = 1;
      usage.push({ step: 'hero_image', modelId: deps.imageModelId ?? 'unknown', inputTokens: 0, outputTokens: 0 });
      const hero = await generateHero(written.heroScene, mediaPrefix(slug), { ...deps, generateImage: deps.generateImage });
      if (hero) media = { ...media, hero };
    }

    const doc: SiteDoc = { answers: job.answers, notes: input.notes, media };
    const draftId = await saveDraft(site, written.source, doc, deps);
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
    return { outcome: 'DONE', ...tokens(), heroImages };
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
