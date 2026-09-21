import type { Stores } from './jobs';
import { hashIp } from './ratelimit';

/** Distinct visitors that must report a site before it is taken offline automatically. */
export const QUARANTINE_AFTER = 3;
const REPORTS_PER_IP_PER_DAY = 10;
const REPORT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ReportDeps {
  stores: Stores;
  ipSalt: string;
  notify(subject: string, message: string): Promise<void>;
  now(): number;
}

export type ReportResult = { status: 202; counted: boolean; quarantined: boolean } | { status: 404 } | { status: 429 };

/**
 * One visitor counts once per site, so a single person cannot take a competitor offline.
 * Quarantine moves the pages aside; `./coyote.sh restore <slug>` brings them back.
 */
export async function reportSite(slug: string, reason: string, ip: string, deps: ReportDeps): Promise<ReportResult> {
  const { stores } = deps;
  const site = await stores.getSite(slug);
  if (!site || site.status !== 'published') return { status: 404 };

  const now = deps.now();
  const ipHash = hashIp(ip, deps.ipSalt);
  const day = new Date(now).toISOString().slice(0, 10);
  const ttl = Math.floor(now / 1000) + REPORT_TTL_SECONDS;
  if (!(await stores.hitRateLimit(`reports#${ipHash}#${day}`, REPORTS_PER_IP_PER_DAY, ttl))) return { status: 429 };

  if (!(await stores.putOnce(`report#${slug}#${ipHash}`, ttl))) return { status: 202, counted: false, quarantined: false };
  const count = await stores.increment(`reportcount#${slug}`, ttl);

  const quarantined = count >= QUARANTINE_AFTER;
  if (quarantined) {
    await stores.copyPrefix(`${slug}/`, `_quarantine/${slug}/`);
    await stores.deletePrefix(`${slug}/`);
    await stores.saveSite({ slug, status: 'quarantined' });
    await stores.invalidateSite(slug);
  }
  await deps.notify(
    quarantined ? `Coyote: ${slug} quarantined after ${count} reports` : `Coyote: report ${count}/${QUARANTINE_AFTER} for ${slug}`,
    `Site: ${slug}\nDistinct reporters: ${count}\nReason given: ${reason.slice(0, 500) || '(none)'}\n\n${quarantined ? `The site is offline. Restore: ./coyote.sh restore ${slug}   Remove for good: ./coyote.sh unpublish ${slug}` : `Take it down now: ./coyote.sh unpublish ${slug}`}`,
  );
  return { status: 202, counted: true, quarantined };
}
