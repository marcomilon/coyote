import { THEMES } from '../../themes';
import { GuardrailBlocked, type CallTool } from './bedrock';
import type { SiteContent } from './content';
import type { Stores } from './jobs';
import { generateSite } from './pipeline';
import { checkHtml, PolicyRejection } from './policy';
import { render } from './render';
import { processUploads, type Media } from './uploads';
import type { Urls } from './urls';

export interface GenerateJobDeps {
  stores: Stores;
  callTool: CallTool;
  modelId: string;
  urls: Urls;
  /** Output guardrail on the visible text. Resolves to true when it may be published. */
  outputAllowed(text: string): Promise<boolean>;
  /** Image moderation. Resolves to the labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
}

export const previewKey = (jobId: string) => `_preview/${jobId}/index.html`;

/** Every text a visitor can read. */
export function visibleText(content: SiteContent): string {
  return [
    content.businessName, content.title, content.description, content.headline, content.subhead, content.about,
    content.ctaText,
    ...content.services.flatMap((s) => [s.name, s.detail ?? '']),
  ].filter(Boolean).join('\n');
}

/**
 * Runs one PENDING job to DONE (preview written), REJECTED (content policy), or FAILED (our error).
 * Rejected and failed jobs give their slug back.
 */
export type GenerateOutcome = { outcome: 'SKIPPED' } | { outcome: 'DONE' | 'REJECTED' | 'FAILED'; tokensIn: number; tokensOut: number };

export async function runGenerateJob(jobId: string, deps: GenerateJobDeps): Promise<GenerateOutcome> {
  const { stores, urls } = deps;
  const job = await stores.getJob(jobId);
  if (!job || job.status !== 'PENDING' || !job.slug) return { outcome: 'SKIPPED' };
  const slug = job.slug;
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    // Images first: moderation costs a tenth of a cent, generation costs twenty times more.
    let media: Media = { photos: [] };
    if (job.uploadId) {
      const processed = await processUploads(job.uploadId, `_preview/${jobId}/`, deps);
      if (!processed.ok) {
        if (!job.regenerate) await stores.releaseSlug(slug, jobId);
        await stores.updateJob(jobId, { status: 'REJECTED', rejectedBy: 'image', rejectDetail: processed.reason.slice(0, 300) });
        return { outcome: 'REJECTED', tokensIn, tokensOut };
      }
      media = processed.media;
    } else if (job.assetsFrom) {
      await stores.copyPrefix(`${job.assetsFrom}assets/`, `_preview/${jobId}/assets/`);
      const kept = (await stores.listKeys(`_preview/${jobId}/assets/`)).map((key) => key.slice(`_preview/${jobId}/`.length)).sort();
      media = { logo: kept.find((k) => k.startsWith('assets/logo')), photos: kept.filter((k) => k.startsWith('assets/photo')) };
    }

    const generated = await generateSite(job.answers, { ...deps, slug: job.seed ?? slug });
    const { brief, usage } = generated;
    const content = { ...generated.content, media };
    const allUsage = [...job.usage, ...usage];
    tokensIn = usage.reduce((n, u) => n + u.inputTokens, 0);
    tokensOut = usage.reduce((n, u) => n + u.outputTokens, 0);

    if (!(await deps.outputAllowed(visibleText(content)))) throw new GuardrailBlocked();

    const page = render({
      theme: THEMES[brief.theme]!,
      content,
      brief,
      siteUrl: urls.siteUrl(slug),
      ...urls.pageLinks(slug, content.lang),
    });
    const htmlViolations = checkHtml(page, { platformOrigins: [new URL(urls.appUrl).origin, urls.siteOrigin(slug)] });
    // A violation here is a theme bug, not the requester's fault.
    if (htmlViolations.length > 0) throw new Error(`rendered page breaks the HTML policy: ${JSON.stringify(htmlViolations)}`);

    await stores.putPage(previewKey(jobId), page);
    // The site record changes only when the owner publishes this version.
    await stores.updateJob(jobId, { status: 'DONE', previewUrl: urls.previewUrl(jobId), usage: allUsage, result: { content, brief } });
    return { outcome: 'DONE', tokensIn, tokensOut };
  } catch (error) {
    if (!job.regenerate) await stores.releaseSlug(slug, jobId);
    if (error instanceof PolicyRejection) {
      await stores.updateJob(jobId, { status: 'REJECTED', rejectedBy: 'policy', rejectDetail: error.message.slice(0, 500) });
    } else if (error instanceof GuardrailBlocked) {
      await stores.updateJob(jobId, { status: 'REJECTED', rejectedBy: 'guardrail', rejectDetail: 'generation' });
    } else {
      console.error('generate failed', { jobId, error });
      await stores.updateJob(jobId, { status: 'FAILED', error: String(error).slice(0, 500) });
      return { outcome: 'FAILED', tokensIn, tokensOut };
    }
    return { outcome: 'REJECTED', tokensIn, tokensOut };
  }
}
