import { describe, expect, it } from 'vitest';
import type { CallTool } from '../src/core/bedrock';
import { runGenerateJob } from '../src/core/generate-job';
import { authenticate, deleteSite, MAX_REGENERATIONS, ownerView, regenerate, republish, unpublish, updateContent, type OwnerDeps } from '../src/core/owner';
import { publish } from '../src/core/publish';
import { submit } from '../src/core/submit';
import { createUrls } from '../src/core/urls';
import { brief, content } from './fixtures';
import { memoryStores } from './memory-stores';

const urls = createUrls({ mode: 'domainless', appBaseUrl: 'https://app.test', apiBaseUrl: 'https://api.test', sitesBaseUrl: 'https://sites.test' });
const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;
const NOW = 1_800_000_000_000;

/** A published site plus its one-time token. */
async function published() {
  const memory = memoryStores();
  let id = 0;
  const started: string[] = [];
  const callTool = (async ({ tool }) => ({
    value: tool.name === 'classify' ? { reason: 'x', decision: 'allow', category: 'ok', confidence: 0.9 } : tool.name === 'design_brief' ? brief : modelContent,
    usage: { step: tool.name, modelId: 'test', inputTokens: 1, outputTokens: 1 },
  })) as CallTool;
  const base = { stores: memory.stores, urls, now: () => NOW, newId: () => `job-${++id}`, startGenerate: async (jobId: string) => void started.push(jobId) };
  const deps: OwnerDeps = { ...base, outputAllowed: async () => true };
  const generateDeps = { stores: memory.stores, callTool, modelId: 'test', urls, outputAllowed: async () => true };

  await submit({ businessName: 'Panadería Luna', about: 'Panadería de masa madre en Chapinero, Bogotá.', whatsapp: '+57 300 123 4567' }, '1.2.3.4', { ...base, callTool, modelId: 'test', rateLimitPerDay: 3, ipSalt: 's' });
  await runGenerateJob('job-1', generateDeps);
  const result = await publish('job-1', base);
  if (result.status !== 200 || !result.miSitioUrl) throw new Error('publish failed');
  const token = decodeURIComponent(result.miSitioUrl.split('#token=')[1]!);
  return { ...memory, deps, generateDeps, base, token, started };
}

describe('magic link', () => {
  it('is issued once, stored only as a hash, and authenticates the owner', async () => {
    const t = await published();
    expect(t.token).toMatch(/^panaderia-luna\.[\w-]{40,}$/);
    const stored = t.sites.get('panaderia-luna')!;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(t.token.split('.')[1]);

    expect(await authenticate(`Bearer ${t.token}`, t.deps)).toMatchObject({ slug: 'panaderia-luna' });
    expect(await authenticate(`Bearer panaderia-luna.${'x'.repeat(43)}`, t.deps)).toBeUndefined();
    expect(await authenticate('Bearer otro-sitio.abc', t.deps)).toBeUndefined();
    expect(await authenticate(undefined, t.deps)).toBeUndefined();
  });

  it('expires', async () => {
    const t = await published();
    const later = { ...t.deps, now: () => NOW + 366 * 86400 * 1000 };
    expect(await authenticate(`Bearer ${t.token}`, later)).toBeUndefined();
  });

  it('never exposes the hash to the page', async () => {
    const t = await published();
    const view = ownerView(t.sites.get('panaderia-luna')!, urls);
    expect(JSON.stringify(view)).not.toContain('tokenHash');
    expect(view).toMatchObject({ status: 'published', regenerationsLeft: MAX_REGENERATIONS, siteUrl: 'https://sites.test/panaderia-luna/' });
  });
});

describe('owner edits', () => {
  it('re-renders the live page with no model call', async () => {
    const t = await published();
    const site = t.sites.get('panaderia-luna')!;
    expect(await updateContent(site, { hours: [{ days: 'Lunes a viernes', time: '9:00 – 18:00' }], contact: { instagram: 'luna.pan' } }, t.deps)).toEqual({ status: 200 });
    const page = t.objects.get('panaderia-luna/index.html')!;
    expect(t.invalidated).toContain('panaderia-luna'); // the change shows at once, not after the cache TTL
    expect(page).toContain('9:00 – 18:00');
    expect(page).toContain('https://instagram.com/luna.pan');
    expect(t.sites.get('panaderia-luna')!.content!.contact.instagram).toBe('luna.pan');
  });

  it('rejects invalid fields, policy violations, and guardrail blocks; the live page stays as it was', async () => {
    const t = await published();
    const site = t.sites.get('panaderia-luna')!;
    const before = t.objects.get('panaderia-luna/index.html');
    expect(await updateContent(site, { contact: { whatsapp: '123' } }, t.deps)).toEqual({ status: 400, fields: ['contact.whatsapp'] });
    expect(await updateContent(site, { title: 'x' }, t.deps)).toMatchObject({ status: 400 });
    expect(await updateContent(site, { about: 'Verifica tu cuenta para seguir comprando.' }, t.deps)).toEqual({ status: 422 });
    expect(await updateContent(site, { about: 'Texto normal.' }, { ...t.deps, outputAllowed: async () => false })).toEqual({ status: 422 });
    expect(t.objects.get('panaderia-luna/index.html')).toBe(before);
  });

  it('unpublishes and republishes', async () => {
    const t = await published();
    await unpublish(t.sites.get('panaderia-luna')!, t.deps);
    expect(t.objects.has('panaderia-luna/index.html')).toBe(false);
    expect(await updateContent(t.sites.get('panaderia-luna')!, { about: 'Nuevo texto.' }, t.deps)).toEqual({ status: 409 });
    expect(await republish(t.sites.get('panaderia-luna')!, t.deps)).toEqual({ status: 200 });
    expect(t.objects.has('panaderia-luna/index.html')).toBe(true);
  });

  it('deletes everything: pages, the site record, and the text of its jobs', async () => {
    const t = await published();
    await deleteSite(t.sites.get('panaderia-luna')!, t.deps);
    expect(t.objects.has('panaderia-luna/index.html')).toBe(false);
    expect(t.sites.has('panaderia-luna')).toBe(false);
    expect(JSON.stringify(t.jobs.get('job-1'))).not.toContain('Chapinero');
    expect(t.invalidated.at(-1)).toBe('panaderia-luna');
    expect(await authenticate(`Bearer ${t.token}`, t.deps)).toBeUndefined();
  });
});

describe('regenerate', () => {
  it('makes a new version from the stored answers; the live site changes only on publish; capped at 2', async () => {
    const t = await published();
    const live = t.objects.get('panaderia-luna/index.html');

    const first = await regenerate(t.jobs.get('job-1'), t.deps);
    expect(first).toMatchObject({ status: 202, regenerationsLeft: 1 });
    const jobId = (first as { jobId: string }).jobId;
    expect(t.jobs.get(jobId)).toMatchObject({ regenerate: true, slug: 'panaderia-luna', seed: 'panaderia-luna:1' });
    expect(t.started).toContain(jobId);

    await runGenerateJob(jobId, t.generateDeps);
    expect(t.objects.get('panaderia-luna/index.html')).toBe(live);
    expect(t.sites.get('panaderia-luna')!.jobIds).toEqual(expect.arrayContaining(['job-1', jobId])); // both are redacted on delete
    const republished = await publish(jobId, t.base);
    expect(republished).toEqual({ status: 200, siteUrl: 'https://sites.test/panaderia-luna/' }); // no second magic link
    expect(t.sites.get('panaderia-luna')!.jobId).toBe(jobId);

    expect(await regenerate(t.jobs.get('job-1'), t.deps)).toMatchObject({ status: 202, regenerationsLeft: 0 });
    expect(await regenerate(t.jobs.get('job-1'), t.deps)).toEqual({ status: 429 });
  });

  it('keeps the slug when a regeneration fails', async () => {
    const t = await published();
    const result = await regenerate(t.jobs.get('job-1'), t.deps);
    const failing = (async () => {
      throw new Error('down');
    }) as CallTool;
    await runGenerateJob((result as { jobId: string }).jobId, { ...t.generateDeps, callTool: failing });
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'published' });
  });
});
