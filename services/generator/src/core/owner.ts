import { THEMES } from '../../themes';
import { applyPatch, type SiteContent } from './content';
import { JOB_TTL_SECONDS, type Job, type SiteRecord, type Stores } from './jobs';
import { checkContent, checkHtml } from './policy';
import { render } from './render';
import { parseToken, secretMatches } from './token';
import type { Urls } from './urls';
import { ZodError } from 'zod';

export const MAX_REGENERATIONS = 2;
const OWNER_REQUESTS_PER_DAY = 60;

export interface OwnerDeps {
  stores: Stores;
  urls: Urls;
  outputAllowed(text: string): Promise<boolean>;
  startGenerate(jobId: string): Promise<void>;
  now(): number;
  newId(): string;
}

/** `Authorization: Bearer <slug>.<secret>` → the site, or undefined. Also enforces a per-site daily cap. */
export async function authenticate(header: string | undefined, { stores, now }: OwnerDeps): Promise<SiteRecord | 'rate_limited' | undefined> {
  const parsed = parseToken(header?.replace(/^Bearer\s+/i, '') ?? '');
  if (!parsed) return undefined;
  const site = await stores.getSite(parsed.slug);
  if (!site?.tokenHash || !site.tokenExpiresAt || site.tokenExpiresAt < now() / 1000) return undefined;
  if (!secretMatches(parsed.secret, site.tokenHash)) return undefined;
  const day = new Date(now()).toISOString().slice(0, 10);
  const allowed = await stores.hitRateLimit(`owner#${site.slug}#${day}`, OWNER_REQUESTS_PER_DAY, Math.floor(now() / 1000) + 2 * 86400);
  return allowed ? site : 'rate_limited';
}

/** What the "Mi sitio" page shows. Only fields an owner may edit, never the token hash. */
export function ownerView(site: SiteRecord, urls: Urls) {
  const c = site.content;
  return {
    slug: site.slug,
    status: site.status,
    siteUrl: urls.siteUrl(site.slug),
    regenerationsLeft: Math.max(0, MAX_REGENERATIONS - (site.regenCount ?? 0)),
    content: c && { headline: c.headline, subhead: c.subhead, about: c.about, services: c.services, hours: c.hours ?? [], ctaText: c.ctaText, contact: c.contact },
  };
}

function renderSite(site: SiteRecord, content: SiteContent, urls: Urls): string {
  const theme = THEMES[site.brief!.theme];
  if (!theme) throw new Error(`unknown theme ${site.brief!.theme}`);
  const page = render({ theme, content, brief: site.brief!, siteUrl: urls.siteUrl(site.slug), reportUrl: urls.reportUrl(site.slug), privacyUrl: urls.privacyUrl });
  const violations = checkHtml(page, { platformOrigins: [new URL(urls.appUrl).origin, urls.siteOrigin(site.slug)] });
  if (violations.length > 0) throw new Error(`rendered page breaks the HTML policy: ${JSON.stringify(violations)}`);
  return page;
}

export type EditResult = { status: 200 } | { status: 400; fields: string[] } | { status: 409 } | { status: 422 };

/** An owner's edit: patch → policy → guardrail → re-render. No model call. */
export async function updateContent(site: SiteRecord, patch: unknown, deps: OwnerDeps): Promise<EditResult> {
  if (site.status !== 'published' || !site.content || !site.brief) return { status: 409 };
  let content: SiteContent;
  try {
    content = applyPatch(site.content, patch);
  } catch (error) {
    if (error instanceof ZodError) return { status: 400, fields: [...new Set(error.issues.map((i) => i.path.join('.')))] };
    throw error;
  }
  if (checkContent(content).length > 0) return { status: 422 };
  const edited = [content.headline, content.subhead, content.about, content.ctaText, content.contact.address ?? '', ...content.services.flatMap((s) => [s.name, s.detail ?? ''])].join('\n');
  if (!(await deps.outputAllowed(edited))) return { status: 422 };

  await deps.stores.putPage(`${site.slug}/index.html`, renderSite(site, content, deps.urls));
  await deps.stores.saveSite({ slug: site.slug, content });
  await deps.stores.invalidateSite(site.slug);
  return { status: 200 };
}

export async function unpublish(site: SiteRecord, { stores }: OwnerDeps): Promise<void> {
  await stores.deletePrefix(`${site.slug}/`);
  await stores.saveSite({ slug: site.slug, status: 'unpublished' });
  await stores.invalidateSite(site.slug);
}

export async function republish(site: SiteRecord, deps: OwnerDeps): Promise<{ status: 200 } | { status: 409 }> {
  if (!site.content || !site.brief) return { status: 409 };
  await deps.stores.putPage(`${site.slug}/index.html`, renderSite(site, site.content, deps.urls));
  await deps.stores.saveSite({ slug: site.slug, status: 'published' });
  await deps.stores.invalidateSite(site.slug);
  return { status: 200 };
}

/** "Delete my data": the pages, the site record (the slug becomes free), and the text of every job. */
export async function deleteSite(site: SiteRecord, { stores }: OwnerDeps): Promise<void> {
  await stores.deletePrefix(`${site.slug}/`);
  for (const jobId of new Set([site.jobId, ...(site.jobIds ?? [])])) await stores.redactJob(jobId);
  await stores.deleteSite(site.slug);
  await stores.invalidateSite(site.slug);
}

export type RegenerateResult = { status: 202; jobId: string; regenerationsLeft: number } | { status: 404 } | { status: 409 } | { status: 429 };

/** A new version from the stored answers. Capped per site. The owner previews it and publishes as usual. */
export async function regenerate(source: Job | undefined, deps: OwnerDeps): Promise<RegenerateResult> {
  if (!source?.slug || !('businessName' in source.answers)) return { status: 404 };
  if (source.status !== 'DONE' && source.status !== 'PUBLISHED') return { status: 409 };
  const site = await deps.stores.getSite(source.slug);
  const used = site?.regenCount ?? 0;
  if (!site || used >= MAX_REGENERATIONS) return { status: 429 };

  const now = deps.now();
  const job: Job = {
    jobId: deps.newId(),
    status: 'PENDING',
    createdAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
    ipHash: source.ipHash,
    answers: source.answers,
    slug: source.slug,
    screening: source.screening,
    usage: [],
    regenerate: true,
    seed: `${source.slug}:${used + 1}`,
  };
  await deps.stores.saveSite({ slug: source.slug, regenCount: used + 1, jobIds: [...new Set([...(site.jobIds ?? []), source.jobId, job.jobId])] });
  await deps.stores.putJob(job);
  await deps.startGenerate(job.jobId);
  return { status: 202, jobId: job.jobId, regenerationsLeft: MAX_REGENERATIONS - used - 1 };
}
