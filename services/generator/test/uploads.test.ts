import { describe, expect, it } from 'vitest';
import type { CallTool } from '../src/core/bedrock';
import { runGenerateJob } from '../src/core/generate-job';
import { regenerate } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { createUploads, processUploads } from '../src/core/uploads';
import { createUrls } from '../src/core/urls';
import { brief, content } from './fixtures';
import { memoryStores } from './memory-stores';

const urls = createUrls({ mode: 'domainless', appBaseUrl: 'https://app.test', apiBaseUrl: 'https://api.test', sitesBaseUrl: 'https://sites.test' });
const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;
const UPLOAD = '3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c';

function setup() {
  const memory = memoryStores();
  let id = 0;
  const callTool = (async ({ tool }) => ({
    value: tool.name === 'classify' ? { reason: 'x', decision: 'allow', category: 'ok', confidence: 0.9 } : tool.name === 'design_brief' ? brief : modelContent,
    usage: { step: tool.name, modelId: 'test', inputTokens: 1, outputTokens: 1 },
  })) as CallTool;
  const base = { stores: memory.stores, now: () => 1_800_000_000_000, newId: () => `job-${++id}`, startGenerate: async () => {} };
  const generateDeps = { stores: memory.stores, callTool, modelId: 'test', urls, outputAllowed: async () => true, moderate: async (): Promise<string[]> => [] };
  const submitDeps = { ...base, callTool, modelId: 'test', rateLimitPerDay: 5, ipSalt: 's' };
  const body = { businessName: 'Panadería Luna', about: 'Panadería de masa madre en Chapinero, Bogotá.', whatsapp: '+57 300 123 4567', uploadId: UPLOAD };
  return { ...memory, base, generateDeps, submitDeps, body };
}

describe('createUploads', () => {
  const deps = (memory = memoryStores()) => ({
    stores: memory.stores, ipSalt: 's', now: () => 1_800_000_000_000, newId: () => UPLOAD,
    presign: async (key: string, contentType: string, maxBytes: number) => ({ url: 'https://s3.test', fields: { key, 'Content-Type': contentType, max: String(maxBytes) } }),
  });

  it('hands out fixed file names and types, never the client\'s', async () => {
    const result = await createUploads({ logo: true, photos: 2, key: '../../evil.html', contentType: 'text/html' }, '1.1.1.1', deps());
    expect(result).toMatchObject({ status: 200, uploadId: UPLOAD });
    if (result.status !== 200) return;
    expect(result.logo!.fields).toMatchObject({ key: `_uploads/${UPLOAD}/logo.png`, 'Content-Type': 'image/png' });
    expect(result.photos.map((p) => p.fields.key)).toEqual([`_uploads/${UPLOAD}/photo-1.jpg`, `_uploads/${UPLOAD}/photo-2.jpg`]);
  });

  it('rejects empty or oversized requests', async () => {
    expect(await createUploads({}, '1.1.1.1', deps())).toEqual({ status: 400 });
    expect(await createUploads({ photos: 9 }, '1.1.1.1', deps())).toEqual({ status: 400 });
  });
});

describe('uploads in a generation', () => {
  it('moderates, copies the images next to the page, and renders them', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/logo.png`, 'png');
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    t.objects.set(`_uploads/${UPLOAD}/evil.html`, '<script>'); // not one of our names: ignored
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);

    const job = t.jobs.get('job-1')!;
    expect(job.status).toBe('DONE');
    expect(job.result!.content.media).toEqual({ logo: 'assets/logo.png', photos: ['assets/photo-1.jpg'] });
    expect(t.objects.has('_preview/job-1/assets/photo-1.jpg')).toBe(true);
    expect(t.objects.has('_preview/job-1/assets/evil.html')).toBe(false);
    const page = t.objects.get('_preview/job-1/index.html')!;
    expect(page).toContain('src="assets/logo.png"');
    expect(page).toContain('src="assets/photo-1.jpg"');
  });

  it('rejects the job before any model call when an image is flagged or is not an image', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    let modelCalls = 0;
    const counting = (async (request) => { modelCalls++; return t.generateDeps.callTool(request); }) as CallTool;
    await runGenerateJob('job-1', { ...t.generateDeps, callTool: counting, moderate: async () => ['Explicit'] });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'image' });
    expect(modelCalls).toBe(0);
    expect(t.sites.size).toBe(0);

    const result = await processUploads(UPLOAD, '_preview/x/', { stores: t.stores, moderate: async () => { throw new Error('InvalidImageFormatException'); } });
    expect(result).toEqual({ ok: false, reason: 'photo-1.jpg: not a valid image' });
  });

  it('a regeneration keeps the images of the previous version', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const again = await regenerate(t.jobs.get('job-1'), { ...t.base, urls, outputAllowed: async () => true });
    const jobId = (again as { jobId: string }).jobId;
    await runGenerateJob(jobId, t.generateDeps);
    expect(t.jobs.get(jobId)!.result!.content.media.photos).toEqual(['assets/photo-1.jpg']);
    expect(t.objects.has(`_preview/${jobId}/assets/photo-1.jpg`)).toBe(true);
  });
});
