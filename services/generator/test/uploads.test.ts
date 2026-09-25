import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { heroPrompt } from '../src/core/images';
import { editSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { createUploads, processUploads } from '../src/core/uploads';
import { MODEL_PAGE } from './fixtures';
import { memoryStores } from './memory-stores';
import { body as formBody, harness } from './harness';

const UPLOAD = '3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c';
const SCENE = 'A small sourdough bakery in Bogotá at dawn, loaves on wooden shelves';

function setup(model: Parameters<typeof harness>[0] = {}) {
  const t = harness(model);
  return { ...t, body: { ...formBody, uploadId: UPLOAD } };
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
  it('moderates, keeps the images with the site, shows them to the model, and copies them into the draft', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/logo.png`, 'png');
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    t.objects.set(`_uploads/${UPLOAD}/evil.html`, '<script>');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);

    expect(t.objects.has('_media/panaderia-luna/assets/photo-1.jpg')).toBe(true);
    expect(t.objects.has('_media/panaderia-luna/assets/evil.html')).toBe(false);
    expect(t.requests.at(-1)!.images!.map((i) => [i.label, i.format])).toEqual([
      ['The logo ({{logo}}):', 'png'],
      ['Photo 1 ({{photo:1}}):', 'jpeg'],
    ]);
    expect(t.objects.get('_draft/draft1/assets/photo-1.jpg')).toBe('jpg');
    const page = t.objects.get('_draft/draft1/index.html')!;
    expect(page).toContain('src="assets/logo.png"');
    expect(page).toContain('url("assets/photo-1.jpg")'); // {{hero}} falls back to the first photo
  });

  it('rejects the job before any model call when an image is flagged or is not an image', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.generateDeps, moderate: async () => ['Explicit'] });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'image', rejectDetail: 'photo-1.jpg: Explicit' });
    expect(t.calls).toEqual(['classify']);
    expect(t.sites.size).toBe(0);

    const result = await processUploads(UPLOAD, '_media/x/', { stores: t.stores, moderate: async () => { throw new Error('InvalidImageFormatException'); } });
    expect(result).toEqual({ ok: false, reason: 'photo-1.jpg: not a valid image' });
  });

  it('an edit keeps the images of the current version', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    await editSite(t.sites.get('panaderia-luna')!, { instruction: 'más oscuro' }, t.ownerDeps);
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.objects.get('_draft/draft2/assets/photo-1.jpg')).toBe('jpg');
    expect(t.requests.at(-1)!.images).toHaveLength(1);
  });
});

describe('generated hero photo', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);

  function heroSetup(options: { image?: Uint8Array; labels?: string[]; sceneAllowed?: boolean } = {}) {
    const t = setup({ heroScene: SCENE });
    const prompts: string[] = [];
    const deps = {
      ...t.generateDeps,
      imageModelId: 'image-test',
      generateImage: async (prompt: string) => {
        prompts.push(prompt);
        return 'image' in options ? options.image : jpeg;
      },
      moderate: async () => options.labels ?? [],
      outputAllowed: async (text: string) => options.sceneAllowed !== false || text !== SCENE,
    };
    return { ...t, deps, prompts, body: formBody };
  }

  it('fills {{hero}} when nothing was uploaded, and records the attempt', async () => {
    const t = heroSetup();
    await submit(t.body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.deps)).toMatchObject({ outcome: 'DONE', heroImages: 1 });
    expect(t.prompts).toEqual([heroPrompt(SCENE)]);
    expect(t.objects.get('_media/panaderia-luna/assets/hero.jpg')).toBe('image/jpeg, 3 bytes');
    expect(t.jobs.get('job-1')!.usage.at(-1)).toMatchObject({ step: 'hero_image', modelId: 'image-test' });
    expect(t.objects.get('_draft/draft1/index.html')).toContain('url("assets/hero.jpg")');
    expect(t.objects.has('_draft/draft1/assets/hero.jpg')).toBe(true);
  });

  it('is not generated when the owner uploaded a photo, or the page has no {{hero}}', async () => {
    const t = heroSetup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit({ ...t.body, uploadId: UPLOAD }, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.deps);
    expect(t.prompts).toEqual([]);

    const u = heroSetup();
    u.options.page = MODEL_PAGE.replace('url({{hero}})', 'none');
    await submit(u.body, '1.2.3.4', u.submitDeps);
    await runGenerateJob('job-1', u.deps);
    expect(u.prompts).toEqual([]);
  });

  it('builds the page without the photo when the scene, the model, or moderation says no', async () => {
    for (const options of [{ sceneAllowed: false }, { image: undefined }, { labels: ['Violence'] }]) {
      const t = heroSetup(options);
      await submit(t.body, '1.2.3.4', t.submitDeps);
      await runGenerateJob('job-1', t.deps);
      expect(t.jobs.get('job-1')).toMatchObject({ status: 'DONE' });
      expect(t.objects.has('_media/panaderia-luna/assets/hero.jpg')).toBe(false);
      expect(t.objects.get('_draft/draft1/index.html')).toContain('background:none center/cover');
    }
  });

  it('builds the page without the photo when the image model fails', async () => {
    const t = heroSetup();
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.deps, generateImage: async () => { throw new Error('ThrottlingException'); } });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'DONE' });
  });

  it('costs nothing when the text is rejected', async () => {
    const t = heroSetup();
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.deps, outputAllowed: async () => false });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED' });
    expect(t.prompts).toEqual([]);
  });
});
