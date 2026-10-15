import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { editSite, ownerView } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { createUploads, mergeMedia, processUploads } from '../src/core/uploads';
import { photoInstruction, restorePhotos } from '../src/core/generate-job';
import { imageRatio, madeRatio } from '../src/core/images';

/** The start of a PNG: signature and header with its size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
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
    const notices: { subject: string; message: string }[] = [];
    await runGenerateJob('job-2', { ...t.generateDeps, announce: async (subject, message) => void notices.push({ subject, message }) });
    // The admin hears about it, with what it cost.
    expect(notices[0]!.subject).toBe('Cambio de fotos: Panadería Luna');
    expect(notices[0]!.message).toContain('Fotos: 2 nuevas, 1 quitada');
    expect(notices[0]!.message).toMatch(/^Costo: /m);

    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE' });
    // A photo change alone asks no questions.
    expect(t.requests.filter((r) => r.tool.name === 'plan_site')).toHaveLength(plans);
    const request = t.writer.requests.at(-1)!;
    expect(request.photos.map((p) => p.file)).toEqual(['assets/photo-f2.jpg', 'assets/photo-f3.jpg']);
    expect(request.instruction).toContain('The owner took out assets/photo-f1.jpg');
    expect(t.objects.get('_draft/draft2/assets/photo-f2.jpg')).toBe('new');
  });

  it('a made photo swapped for the owner\'s in Tus fotos: moderated, put in its place, no page writer', async () => {
    const t = setup();
    await submit({ ...t.body, uploadId: undefined }, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    // A page with a made photo.
    const doc = JSON.parse(t.objects.get('_src/panaderia-luna/draft1.json')!);
    doc.media.generated = ['assets/gen-abc.jpg'];
    doc.page = doc.page.replace('</main>', '<img src="assets/gen-abc.jpg" alt="Pan en el horno"><div style="background:url(assets/gen-abc.jpg)"></div></main>');
    t.objects.set('_src/panaderia-luna/draft1.json', JSON.stringify(doc));
    t.objects.set('_media/panaderia-luna/assets/gen-abc.jpg', 'made');
    const site = () => t.sites.get('panaderia-luna')!;
    expect((await ownerView(site(), t.ownerDeps)).made).toEqual([{ file: 'assets/gen-abc.jpg', url: expect.stringContaining('assets/gen-abc.jpg') }]);

    t.objects.set(`_uploads/${UPLOAD}/photo-1.jpg`, 'mine');
    expect(await editSite(site(), { uploadId: UPLOAD, replaceMade: ['assets/gen-zzz.jpg'] }, t.ownerDeps)).toEqual({ status: 400, fields: ['replaceMade'] });
    expect(await editSite(site(), { uploadId: UPLOAD, replaceMade: ['assets/gen-abc.jpg'], instruction: 'más grande' }, t.ownerDeps)).toEqual({ status: 400, fields: ['replaceMade'] });
    expect(await editSite(site(), { uploadId: UPLOAD, replaceMade: ['assets/gen-abc.jpg'], newCaptions: ['Nuestro horno de leña'] }, t.ownerDeps)).toMatchObject({ status: 202 });
    const writes = t.writer.requests.length;
    const notices: string[] = [];
    await runGenerateJob('job-2', { ...t.generateDeps, announce: async (_, message) => void notices.push(message) });

    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE' });
    expect(t.writer.requests).toHaveLength(writes); // no page writer
    const page = t.objects.get('_draft/draft2/index.html')!;
    expect(page).not.toContain('gen-abc');
    expect(page).toContain('<img src="assets/photo-f1.jpg" alt="Nuestro horno de leña">');
    expect(page).toContain('url(assets/photo-f1.jpg)');
    expect(t.objects.get('_draft/draft2/assets/photo-f1.jpg')).toBe('mine');
    const saved = JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!);
    expect(saved.media).toMatchObject({ photos: ['assets/photo-f1.jpg'], captions: { 'assets/photo-f1.jpg': 'Nuestro horno de leña' } });
    expect(saved.media.generated).toBeUndefined();
    expect(notices[0]).toContain('Fotos: 1 nueva, 1 en lugar de una creada con IA, sin rediseño');

    // A redesign is told to keep the owner's photo, and gets it back when it puts a made photo of its shape in its place.
    t.stores.getBytes = async () => png(1200, 900); // the owner's photo: 4:3
    t.writer.options.page = (request) => request.current!.split('assets/photo-f1.jpg').join('assets/gen-0a1b2c3d-3x2.jpg');
    expect(await editSite(site(), { instruction: 'hazla más moderna' }, t.ownerDeps)).toMatchObject({ status: 202 });
    await runGenerateJob('job-3', { ...t.generateDeps, announce: async (_, message) => void notices.push(message) });
    expect(t.writer.requests.at(-1)!.keepPhotos).toEqual(['assets/photo-f1.jpg']);
    expect(t.objects.get('_draft/draft3/index.html')).toContain('<img src="assets/photo-f1.jpg" alt="Nuestro horno de leña">');
    expect(notices.at(-1)).toContain('Fotos del dueño: 0 mantenidas, 1 devueltas, 0 perdidas');
  });

  it('restorePhotos: puts back left-out owner photos in place of made ones of a similar shape, unless the request is about photos', () => {
    const before = '<img src="assets/photo-a.jpg"><img src="assets/photo-b.jpg"><img src="assets/photo-c.jpg">';
    const after = '<img src="assets/gen-0001-16x9.jpg"><img src="assets/gen-0002-1x1.jpg"><img src="assets/photo-b.jpg">';
    const photos = ['assets/photo-a.jpg', 'assets/photo-b.jpg', 'assets/photo-c.jpg'];
    // a: portrait 3:4, fits the square, not the wide one; c: unknown shape, stays out.
    const ratios = { 'assets/photo-a.jpg': 0.75, 'assets/photo-b.jpg': 1.5 };
    expect(restorePhotos(before, after, photos, [], 'más moderna', ratios)).toEqual({
      page: '<img src="assets/gen-0001-16x9.jpg"><img src="assets/photo-a.jpg"><img src="assets/photo-b.jpg">',
      kept: 1,
      restored: ['assets/photo-a.jpg'],
      lost: ['assets/photo-c.jpg'],
    });
    expect(restorePhotos(before, after, photos, [], 'quita la primera foto', ratios)).toMatchObject({ page: after, restored: [] });
    // Only a wide frame: the portrait photo stays out rather than be cropped.
    expect(restorePhotos(before, '<img src="assets/gen-0001-16x9.jpg">', ['assets/photo-a.jpg'], [], '', ratios)).toMatchObject({ restored: [], lost: ['assets/photo-a.jpg'] });
  });

  it('reads the shape of a PNG or JPEG, and of a made photo from its name', () => {
    expect(imageRatio(png(1200, 900))).toBe(4 / 3);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x02, 0x58, 0x03]);
    expect(imageRatio(jpeg)).toBe(600 / 800);
    expect(imageRatio(new TextEncoder().encode('not an image'))).toBeUndefined();
    expect(madeRatio('assets/gen-0a1b2c3d-16x9.jpg')).toBe(16 / 9);
    expect(madeRatio('assets/gen-0a1b2c3d.jpg')).toBeUndefined();
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
