import type { Stores } from './jobs';
import { issueToken, TOKEN_TTL_SECONDS } from './token';
import type { Urls } from './urls';

export type PublishResult =
  | { status: 200; siteUrl: string; miSitioUrl?: string; ownerWhatsApp?: string }
  | { status: 404 }
  | { status: 409 };

/**
 * Copies the preview to the site folder and the generated content to the site record. Safe to call twice.
 * The first publish of a site issues the owner's magic link, which is returned once and never again.
 */
export async function publish(
  jobId: string,
  { stores, urls, now }: { stores: Stores; urls: Urls; now(): number },
): Promise<PublishResult> {
  const job = await stores.getJob(jobId);
  if (!job || !job.slug) return { status: 404 };
  if (job.status === 'PUBLISHED' && job.siteUrl) return { status: 200, siteUrl: job.siteUrl };
  if (job.status !== 'DONE' || !job.result) return { status: 409 };

  const slug = job.slug;
  const site = await stores.getSite(slug);
  const first = !site?.tokenHash;
  const issued = first ? issueToken(slug) : undefined;

  await stores.copyPrefix(`_preview/${jobId}/`, `${slug}/`);
  await stores.saveSite({
    slug,
    status: 'published',
    jobId,
    createdAt: site?.createdAt ?? job.createdAt,
    content: job.result.content,
    brief: job.result.brief,
    ownerWhatsApp: job.answers.contact.whatsapp,
    jobIds: [...new Set([...(site?.jobIds ?? []), jobId])],
    ...(issued ? { tokenHash: issued.tokenHash, tokenExpiresAt: Math.floor(now() / 1000) + TOKEN_TTL_SECONDS } : {}),
  });
  await stores.invalidateSite(slug);
  const siteUrl = urls.siteUrl(slug);
  await stores.updateJob(jobId, { status: 'PUBLISHED', siteUrl });

  return {
    status: 200,
    siteUrl,
    ...(issued ? { miSitioUrl: urls.miSitioUrl(issued.token), ownerWhatsApp: job.answers.contact.whatsapp } : {}),
  };
}
