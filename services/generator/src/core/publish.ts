import type { Stores } from './jobs';
import type { Urls } from './urls';

export type PublishResult = { status: 200; siteUrl: string } | { status: 404 } | { status: 409 };

/** Copies the preview to the site folder. Safe to call twice. */
export async function publish(jobId: string, { stores, urls }: { stores: Stores; urls: Urls }): Promise<PublishResult> {
  const job = await stores.getJob(jobId);
  if (!job || !job.slug) return { status: 404 };
  if (job.status === 'PUBLISHED' && job.siteUrl) return { status: 200, siteUrl: job.siteUrl };
  if (job.status !== 'DONE') return { status: 409 };

  await stores.copyPrefix(`_preview/${jobId}/`, `${job.slug}/`);
  const siteUrl = urls.siteUrl(job.slug);
  await stores.updateJob(jobId, { status: 'PUBLISHED', siteUrl });
  await stores.saveSite({ slug: job.slug, status: 'published', jobId, createdAt: job.createdAt });
  return { status: 200, siteUrl };
}
