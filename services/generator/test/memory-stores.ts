import type { Job, SiteRecord, Stores } from '../src/core/jobs';

/** In-memory Stores for tests. Exposes its state for assertions. */
export function memoryStores() {
  const jobs = new Map<string, Job>();
  const sites = new Map<string, SiteRecord>();
  const counters = new Map<string, number>();
  const blocked = new Set<string>();
  const objects = new Map<string, string>();

  const stores: Stores = {
    async hitRateLimit(key, max) {
      const count = counters.get(key) ?? 0;
      if (count >= max) return false;
      counters.set(key, count + 1);
      return true;
    },
    isBlocked: async (slug) => blocked.has(slug),
    async claimSlug(site) {
      if (sites.has(site.slug)) return false;
      sites.set(site.slug, site);
      return true;
    },
    async releaseSlug(slug, jobId) {
      const site = sites.get(slug);
      if (site && site.jobId === jobId && site.status !== 'published') sites.delete(slug);
    },
    async saveSite(site) {
      sites.set(site.slug, { ...sites.get(site.slug), ...site });
    },
    async putJob(job) {
      jobs.set(job.jobId, structuredClone(job));
    },
    getJob: async (jobId) => jobs.get(jobId),
    async updateJob(jobId, patch) {
      const job = jobs.get(jobId);
      if (!job) throw new Error('no such job');
      jobs.set(jobId, { ...job, ...patch });
    },
    async putPage(key, page) {
      objects.set(key, page);
    },
    async copyPrefix(from, to) {
      for (const [key, value] of [...objects]) if (key.startsWith(from)) objects.set(to + key.slice(from.length), value);
    },
  };
  return { stores, jobs, sites, counters, blocked, objects };
}
