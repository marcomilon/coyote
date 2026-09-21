import { describe, expect, it } from 'vitest';
import { GuardrailBlocked, type CallTool } from '../src/core/bedrock';
import { runGenerateJob } from '../src/core/generate-job';
import { publicJob, PENDING_TIMEOUT_MS } from '../src/core/jobs';
import { publish } from '../src/core/publish';
import { submit, type SubmitDeps } from '../src/core/submit';
import { createUrls } from '../src/core/urls';
import { brief, content } from './fixtures';
import { memoryStores } from './memory-stores';

const body = {
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá.',
  whatsapp: '+57 300 123 4567',
};
const urls = createUrls({
  mode: 'domainless',
  appBaseUrl: 'https://app.test',
  apiBaseUrl: 'https://api.test',
  sitesBaseUrl: 'https://sites.test',
});
const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;
const usage = (step: string) => ({ step, modelId: 'test', inputTokens: 1, outputTokens: 1 });

function setup(options: { classify?: 'allow' | 'reject'; about?: string } = {}) {
  const memory = memoryStores();
  const calls: string[] = [];
  const started: string[] = [];
  let id = 0;
  const callTool = (async ({ tool }) => {
    calls.push(tool.name);
    if (tool.name === 'classify') {
      const reject = options.classify === 'reject';
      return { value: { reason: 'x', decision: reject ? 'reject' : 'allow', category: reject ? 'adult' : 'ok', confidence: 0.95 }, usage: usage('classify') };
    }
    if (tool.name === 'design_brief') return { value: brief, usage: usage(tool.name) };
    return { value: { ...modelContent, about: options.about ?? modelContent.about }, usage: usage(tool.name) };
  }) as CallTool;
  const deps: SubmitDeps = {
    stores: memory.stores,
    callTool,
    modelId: 'test',
    rateLimitPerDay: 3,
    ipSalt: 'salt',
    startGenerate: async (jobId) => void started.push(jobId),
    now: () => 1_800_000_000_000,
    newId: () => `job-${++id}`,
  };
  const generateDeps = { stores: memory.stores, callTool, modelId: 'test', urls, outputAllowed: async () => true };
  return { ...memory, calls, started, deps, generateDeps };
}

describe('submit', () => {
  it('accepts a normal request: claims the clean slug, stores the job, starts generation', async () => {
    const t = setup();
    expect(await submit(body, '1.2.3.4', t.deps)).toEqual({ status: 202, jobId: 'job-1' });
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'claimed', jobId: 'job-1' });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'PENDING', slug: 'panaderia-luna' });
    expect(t.jobs.get('job-1')!.ipHash).not.toContain('1.2.3.4');
    expect(t.started).toEqual(['job-1']);
  });

  it('rejects invalid input without touching the quota or the model', async () => {
    const t = setup();
    expect(await submit({ ...body, whatsapp: '123' }, '1.2.3.4', t.deps)).toEqual({ status: 400, fields: ['contact.whatsapp'] });
    expect(await submit('not json', '1.2.3.4', t.deps)).toMatchObject({ status: 400 });
    expect(t.calls).toEqual([]);
    expect(t.counters.size).toBe(0);
  });

  it('rate limits per IP before any model call', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) expect((await submit(body, '1.2.3.4', t.deps)).status).toBe(202);
    const callsBefore = t.calls.length;
    expect(await submit(body, '1.2.3.4', t.deps)).toEqual({ status: 429 });
    expect(t.calls.length).toBe(callsBefore);
    expect((await submit(body, '5.6.7.8', t.deps)).status).toBe(202); // another visitor is unaffected
  });

  it('rejects a brand name without a model call, and records why', async () => {
    const t = setup();
    expect(await submit({ ...body, businessName: 'Bancolombia Soporte' }, '1.2.3.4', t.deps)).toEqual({ status: 422 });
    expect(t.calls).toEqual([]);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'brand' });
    expect(t.sites.size).toBe(0);
  });

  it('rejects what the classifier rejects, claiming no slug and starting nothing', async () => {
    const t = setup({ classify: 'reject' });
    expect(await submit(body, '1.2.3.4', t.deps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'prescreen', rejectDetail: 'adult' });
    expect(t.sites.size).toBe(0);
    expect(t.started).toEqual([]);
  });

  it('treats a guardrail block on the input as a rejection', async () => {
    const t = setup();
    t.deps.callTool = (async () => {
      throw new GuardrailBlocked();
    }) as CallTool;
    expect(await submit(body, '1.2.3.4', t.deps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ rejectedBy: 'guardrail' });
  });

  it('adds a suffix when the slug is taken, reserved, or blocklisted', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    await submit(body, '5.6.7.8', t.deps);
    expect(t.jobs.get('job-2')!.slug).toMatch(/^panaderia-luna-[a-z0-9]{4}$/);

    await submit({ ...body, businessName: 'Admin' }, '9.9.9.9', t.deps);
    expect(t.jobs.get('job-3')!.slug).toMatch(/^admin-[a-z0-9]{4}$/);

    t.blocked.add('floreria-sol');
    await submit({ ...body, businessName: 'Florería Sol' }, '8.8.8.8', t.deps);
    expect(t.jobs.get('job-4')!.slug).toMatch(/^floreria-sol-[a-z0-9]{4}$/);
  });
});

describe('runGenerateJob', () => {
  it('writes the preview, stores the content, and marks the job DONE', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    await runGenerateJob('job-1', t.generateDeps);

    expect(t.jobs.get('job-1')).toMatchObject({ status: 'DONE', previewUrl: 'https://sites.test/_preview/job-1/' });
    expect(t.jobs.get('job-1')!.usage.map((u) => u.step)).toEqual(['classify', 'design_brief', 'publish_content']);
    expect(t.objects.get('_preview/job-1/index.html')).toContain('https://wa.me/573001234567');
    expect(t.jobs.get('job-1')!.result!.content.headline).toBe(content.headline);
    // The site record is untouched until the owner publishes.
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'claimed' });
    expect(t.sites.get('panaderia-luna')!.content).toBeUndefined();
  });

  it('rejects content that breaks the policy and frees the slug', async () => {
    const t = setup({ about: 'Verifica tu cuenta para seguir comprando.' });
    await submit(body, '1.2.3.4', t.deps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    expect(t.sites.size).toBe(0);
    expect(t.objects.size).toBe(0);
  });

  it('rejects when the output guardrail blocks the text', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    await runGenerateJob('job-1', { ...t.generateDeps, outputAllowed: async () => false });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'guardrail' });
    expect(t.objects.size).toBe(0);
  });

  it('marks the job FAILED on an unexpected error and frees the slug', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    const failing = (async () => {
      throw new Error('bedrock is down');
    }) as CallTool;
    await runGenerateJob('job-1', { ...t.generateDeps, callTool: failing });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'FAILED' });
    expect(t.sites.size).toBe(0);
  });

  it('ignores jobs that are not PENDING', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    await runGenerateJob('job-1', t.generateDeps);
    const calls = t.calls.length;
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.calls.length).toBe(calls);
  });
});

describe('publish and status', () => {
  it('copies the preview to the site folder, keeps the stored content, and is idempotent', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    expect(await publish('job-1', { stores: t.stores, urls, now: t.deps.now })).toEqual({ status: 409 }); // not generated yet
    await runGenerateJob('job-1', t.generateDeps);

    const result = await publish('job-1', { stores: t.stores, urls, now: t.deps.now });
    expect(result).toMatchObject({ status: 200, siteUrl: 'https://sites.test/panaderia-luna/', ownerWhatsApp: '573001234567' });
    expect(t.objects.get('panaderia-luna/index.html')).toBe(t.objects.get('_preview/job-1/index.html'));
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'published' });
    expect(t.sites.get('panaderia-luna')!.content).toBeDefined();
    // The magic link is shown once: a second call returns the site URL only.
    expect(await publish('job-1', { stores: t.stores, urls, now: t.deps.now })).toEqual({ status: 200, siteUrl: 'https://sites.test/panaderia-luna/' });
    expect(await publish('nope', { stores: t.stores, urls, now: t.deps.now })).toEqual({ status: 404 });
  });

  it('shows the browser only public fields, and FAILED for a stuck job', async () => {
    const t = setup();
    await submit(body, '1.2.3.4', t.deps);
    const job = t.jobs.get('job-1')!;
    expect(publicJob(job, job.createdAt + 1000)).toEqual({ jobId: 'job-1', status: 'PENDING', slug: 'panaderia-luna', previewUrl: undefined, siteUrl: undefined });
    expect(publicJob(job, job.createdAt + PENDING_TIMEOUT_MS + 1).status).toBe('FAILED');
  });
});
