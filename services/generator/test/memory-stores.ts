import type { Account, AccountToken, ChatMessage, Job, SiteRecord, Stores } from '../src/core/jobs';

/** In-memory Stores for tests. Exposes its state for assertions. */
export function memoryStores() {
  const jobs = new Map<string, Job>();
  const sites = new Map<string, SiteRecord>();
  const counters = new Map<string, number>();
  const blocked = new Set<string>();
  const objects = new Map<string, string>();
  const invalidated: string[] = [];
  /** The Cache-Control of each page put with one. */
  const pageCache = new Map<string, string>();
  const chat: ChatMessage[] = [];
  const accounts = new Map<string, Account>();
  const accountTokens = new Map<string, AccountToken>();

  const stores: Stores = {
    async hitRateLimit(key, max) {
      const count = counters.get(key) ?? 0;
      if (count >= max) return false;
      counters.set(key, count + 1);
      return true;
    },
    isBlocked: async (slug) => blocked.has(slug),
    async block(slug) {
      blocked.add(slug);
    },
    async putOnce(key) {
      if (counters.has(key)) return false;
      counters.set(key, 1);
      return true;
    },
    async increment(key) {
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return counters.get(key)!;
    },
    async claimSlug(site) {
      if (sites.has(site.slug)) return false;
      sites.set(site.slug, site);
      return true;
    },
    async releaseSlug(slug, jobId) {
      const site = sites.get(slug);
      if (site && site.jobId === jobId && site.status === 'claimed' && !site.currentDraftId) sites.delete(slug);
    },
    async saveSite(site) {
      sites.set(site.slug, { ...sites.get(site.slug), ...site } as SiteRecord);
    },
    getSite: async (slug) => sites.get(slug),
    async deleteSite(slug) {
      sites.delete(slug);
    },
    async redactJob(jobId) {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, answers: { deleted: true } as never, notes: undefined, instruction: undefined, questions: undefined, ownerToken: undefined, ownerEmail: undefined });
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
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
    async invalidateSite(slug) {
      invalidated.push(slug);
    },
    async invalidatePaths(paths) {
      invalidated.push(...paths);
    },
    async transitionJob(jobId, from, patch) {
      const job = jobs.get(jobId);
      if (!job || job.status !== from) return false;
      jobs.set(jobId, { ...job, ...patch });
      return true;
    },
    async takeOwnerToken(jobId) {
      const job = jobs.get(jobId);
      if (!job?.ownerToken) return undefined;
      jobs.set(jobId, { ...job, ownerToken: undefined });
      return job.ownerToken;
    },
    async putPrivate(key, body) {
      objects.set(key, body);
    },
    getText: async (key) => objects.get(key),
    getBytes: async (key) => (objects.has(key) ? new TextEncoder().encode(objects.get(key)) : undefined),
    async putPage(key, page, cacheControl) {
      objects.set(key, page);
      if (cacheControl) pageCache.set(key, cacheControl);
    },
    async putAsset(key, body, contentType) {
      objects.set(key, `${contentType}, ${body.length} bytes`);
    },
    listKeys: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    async copyObject(from, to) {
      objects.set(to, objects.get(from) ?? '');
    },
    async copyPrefix(from, to) {
      for (const [key, value] of [...objects]) if (key.startsWith(from)) objects.set(to + key.slice(from.length), value);
    },
    async putChat(message) {
      const at = chat.findIndex((m) => m.slug === message.slug && m.at === message.at);
      if (at === -1) chat.push(structuredClone(message));
      else chat[at] = structuredClone(message);
      chat.sort((a, b) => a.at - b.at);
    },
    async updateChat(slug, at, patch) {
      const message = chat.find((m) => m.slug === slug && m.at === at);
      if (!message) throw new Error('no such message');
      Object.assign(message, patch);
    },
    listChat: async (slug, after, limit) => structuredClone(chat.filter((m) => m.slug === slug && m.at > after).slice(-limit)),
    async deleteChat(slug) {
      for (let i = chat.length - 1; i >= 0; i--) if (chat[i]!.slug === slug) chat.splice(i, 1);
    },
    async linkAccountSite(emailId, email, lang, site) {
      const account = accounts.get(emailId) ?? { email, lang, sites: [] };
      accounts.set(emailId, { ...account, email, sites: [...account.sites.filter((s) => s.slug !== site.slug), site] });
    },
    getAccount: async (emailId) => structuredClone(accounts.get(emailId)),
    async unlinkAccountSite(emailId, slug) {
      const account = accounts.get(emailId);
      if (!account) return;
      const sites = account.sites.filter((s) => s.slug !== slug);
      if (sites.length === 0) accounts.delete(emailId);
      else accounts.set(emailId, { ...account, sites });
    },
    async putAccountToken(token) {
      accountTokens.set(`${token.kind}#${token.id}`, structuredClone(token));
    },
    getAccountToken: async (kind, id) => structuredClone(accountTokens.get(`${kind}#${id}`)),
    async takeAccountToken(kind, id) {
      const token = accountTokens.get(`${kind}#${id}`);
      accountTokens.delete(`${kind}#${id}`);
      return token;
    },
  };
  return { stores, jobs, sites, counters, blocked, objects, invalidated, pageCache, chat, accounts, accountTokens };
}
