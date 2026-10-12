import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { editSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { createUploads, mergeMedia, processUploads } from '../src/core/uploads';
import { photoInstruction } from '../src/core/generate-job';
import { memoryStores } from './memory-stores';
import { body as formBody, harness } from './harness';

const UPLOAD = '3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c';

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
    expect(await createUploads({ photos: 7 }, '1.1.1.1', deps())).toEqual({ status: 400 });
    expect(await createUploads({ photos: 6 }, '1.1.1.1', deps())).toMatchObject({ status: 200 });
  });
});

describe('mergeMedia', () => {
  const current = { logo: 'assets/logo.png', photos: ['assets/photo-1.jpg', 'assets/photo-2.jpg'], generated: ['assets/gen-1.jpg'] };

  it('a new logo replaces the old one, new photos go last, removed ones go', () => {
    expect(mergeMedia(current, { logo: 'assets/logo-a.png', photos: ['assets/photo-b.jpg'] }, ['assets/photo-1.jpg'])).toEqual({
      logo: 'assets/logo-a.png', photos: ['assets/photo-2.jpg', 'assets/photo-b.jpg'], generated: ['assets/gen-1.jpg'],
    });
    expect(mergeMedia(current, { photos: [] }, ['assets/logo.png'])).toEqual({ photos: current.photos, generated: current.generated });
  });

  it('keeps at most 6 photos, the newest', () => {
    const added = Array.from({ length: 6 }, (_, i) => `assets/photo-n${i}.jpg`);
    expect(mergeMedia(current, { photos: added }).photos).toEqual(added);
  });

  it('asks the page writer to place what was added and take out what was removed', () => {
    const media = { logo: 'assets/logo-a.png', photos: ['assets/photo-b.jpg', 'assets/photo-2.jpg'], captions: { 'assets/photo-b.jpg': 'Lomo saltado', 'assets/photo-2.jpg': 'El local' } };
    expect(photoInstruction({ added: ['assets/logo-a.png', 'assets/photo-b.jpg'], removed: ['assets/photo-1.jpg'], described: ['assets/photo-2.jpg'] }, media)).toBe(
      "Use the owner's new logo (assets/logo-a.png) in place of the current one. The owner added a photo of the business: assets/photo-b.jpg (\"Lomo saltado\"). Use it where it fits best, in place of made photos or drawings where that suits the page. The owner described assets/photo-2.jpg as \"El local\": place it to match. The owner took out assets/photo-1.jpg: remove it from the page.",
    );
  });

  it('keeps the descriptions of the photos that stay, changed or cleared as the owner asks', () => {
    const media = { photos: ['assets/a.jpg', 'assets/b.jpg', 'assets/c.jpg'], captions: { 'assets/a.jpg': 'Pan', 'assets/b.jpg': 'Torta', 'assets/c.jpg': 'Local' } };
    expect(mergeMedia(media, { photos: ['assets/d.jpg'], captions: { 'assets/d.jpg': 'Café' } }, ['assets/c.jpg'], { 'assets/a.jpg': 'Pan de masa madre', 'assets/b.jpg': '' })).toEqual({
      photos: ['assets/a.jpg', 'assets/b.jpg', 'assets/d.jpg'],
      captions: { 'assets/a.jpg': 'Pan de masa madre', 'assets/d.jpg': 'Café' },
    });
  });
});

describe('uploads in a generation', () => {
  it('moderates, keeps the images with the site, shows them to the models, and copies them into the draft', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/logo.png`, 'png');
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    t.objects.set(`_uploads/${UPLOAD}/evil.html`, '<script>');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);

    expect(t.objects.has('_media/panaderia-luna/assets/photo-f2.jpg')).toBe(true);
    expect(t.objects.has('_media/panaderia-luna/assets/evil.html')).toBe(false);
    expect(t.requests.find((r) => r.tool.name === 'plan_site')!.images!.map((i) => [i.label, i.format])).toEqual([
      ['The logo:', 'png'],
      ['Photo 1:', 'jpeg'],
    ]);
    expect(t.objects.get('_draft/draft1/assets/photo-f2.jpg')).toBe('jpg');
    // The page writer gets the images, by the file names the page uses.
    expect(t.writer.requests[0]!.photos.map((p) => [p.file, p.mediaType])).toEqual([
      ['assets/logo-f1.png', 'image/png'],
      ['assets/photo-f2.jpg', 'image/jpeg'],
    ]);
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
    expect(t.objects.get('_draft/draft2/assets/photo-f1.jpg')).toBe('jpg');
    expect(t.requests.find((r) => r.tool.name === 'plan_site' && r.guarded.includes('<request>'))!.images).toHaveLength(1);
  });

  it('photos added and taken out in Mi sitio: moderated, merged, and the page writer is told', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await submit(t.body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const added = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
    t.objects.set(`_uploads/${added}/photo-1.jpg`, 'new');
    t.objects.set(`_uploads/${added}/photo-2.jpg`, 'new2');

    expect(await editSite(t.sites.get('panaderia-luna')!, { removePhotos: ['assets/other.jpg'] }, t.ownerDeps)).toEqual({ status: 400, fields: ['removePhotos'] });
    expect(await editSite(t.sites.get('panaderia-luna')!, { uploadId: added, removePhotos: ['assets/photo-f1.jpg'] }, t.ownerDeps)).toEqual({ status: 202, jobId: 'job-2' });
    const plans = t.requests.filter((r) => r.tool.name === 'plan_site').length;
    await runGenerateJob('job-2', t.generateDeps);

    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE' });
    // A photo change alone asks no questions.
    expect(t.requests.filter((r) => r.tool.name === 'plan_site')).toHaveLength(plans);
    const request = t.writer.requests.at(-1)!;
    expect(request.photos.map((p) => p.file)).toEqual(['assets/photo-f2.jpg', 'assets/photo-f3.jpg']);
    expect(request.instruction).toContain('The owner took out assets/photo-f1.jpg');
    expect(t.objects.get('_draft/draft2/assets/photo-f2.jpg')).toBe('new');
  });

  it('a flagged photo added in Mi sitio rejects the change and keeps the site', async () => {
    const t = setup();
    await submit({ ...t.body, uploadId: undefined }, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    await editSite(t.sites.get('panaderia-luna')!, { uploadId: UPLOAD }, t.ownerDeps);
    await runGenerateJob('job-2', { ...t.generateDeps, moderate: async () => ['Explicit'] });
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'REJECTED', rejectedBy: 'image' });
    expect(t.sites.get('panaderia-luna')).toMatchObject({ currentDraftId: 'draft1' });
  });

  it('photo descriptions: from the form to the models, and changed in Mi sitio', async () => {
    const t = setup();
    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'jpg');
    t.objects.set(`_uploads/${UPLOAD}/photo-2.jpg`, 'jpg2');
    await submit({ ...t.body, photoNotes: ['', 'Nuestro lomo saltado'] }, '1.2.3.4', t.submitDeps);
    // Screened with the rest of the form.
    expect(t.requests.find((r) => r.tool.name === 'classify')!.guarded).toContain('Photo 2: Nuestro lomo saltado');
    await runGenerateJob('job-1', t.generateDeps);

    expect(t.requests.find((r) => r.tool.name === 'plan_site')!.images!.map((i) => i.label)).toEqual(['Photo 1:', 'Photo 2 (the owner says it shows: Nuestro lomo saltado):']);
    expect(t.writer.requests[0]!.photos.map((p) => [p.file, p.caption])).toEqual([['assets/photo-f1.jpg', undefined], ['assets/photo-f2.jpg', 'Nuestro lomo saltado']]);
    const site = t.sites.get('panaderia-luna')!;
    const doc = JSON.parse(String(t.objects.get('_src/panaderia-luna/draft1.json')));
    expect(doc.media.captions).toEqual({ 'assets/photo-f2.jpg': 'Nuestro lomo saltado' });
    expect(doc.answers.photoNotes).toBeUndefined();

    expect(await editSite(site, { captions: { 'assets/other.jpg': 'x' } }, t.ownerDeps)).toEqual({ status: 400, fields: ['captions'] });
    // A description alone is a change: screened, then the page writer places the photo to match.
    expect(await editSite(site, { captions: { 'assets/photo-f1.jpg': 'El local por fuera' } }, t.ownerDeps)).toEqual({ status: 202, jobId: 'job-2' });
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.requests.filter((r) => r.tool.name === 'classify').at(-1)!.guarded).toContain('El local por fuera');
    expect(t.writer.requests.at(-1)!.instruction).toContain('The owner described assets/photo-f1.jpg as "El local por fuera"');
    expect(JSON.parse(String(t.objects.get('_src/panaderia-luna/draft2.json'))).media.captions).toEqual({ 'assets/photo-f1.jpg': 'El local por fuera', 'assets/photo-f2.jpg': 'Nuestro lomo saltado' });
  });
});
