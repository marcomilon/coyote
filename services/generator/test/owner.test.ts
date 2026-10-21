import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { authenticate, deleteSite, editSite, ownerView, undo } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { body, harness, NOW, urls } from './harness';

/** A site with its first draft, plus the owner's token. */
async function withDraft(model: Parameters<typeof harness>[0] = {}) {
  const t = harness(model);
  await submit(body, '1.2.3.4', t.submitDeps);
  await runGenerateJob('job-1', t.generateDeps);
  const token = (await t.stores.takeOwnerToken('job-1'))!;
  const site = () => t.sites.get('panaderia-luna')!;
  return { ...t, token, site };
}

describe('magic link', () => {
  it('is issued when the first draft is ready, stored only as a hash, and authenticates the owner', async () => {
    const t = await withDraft();
    expect(t.token).toMatch(/^panaderia-luna\.[\w-]{40,}$/);
    expect(t.site().tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t.site())).not.toContain(t.token.split('.')[1]);

    expect(await authenticate(`Bearer ${t.token}`, t.ownerDeps)).toMatchObject({ slug: 'panaderia-luna' });
    expect(await authenticate(`Bearer panaderia-luna.${'x'.repeat(43)}`, t.ownerDeps)).toBeUndefined();
    expect(await authenticate('Bearer otro-sitio.abc', t.ownerDeps)).toBeUndefined();
    expect(await authenticate(undefined, t.ownerDeps)).toBeUndefined();
  });

  it('expires', async () => {
    const t = await withDraft();
    expect(await authenticate(`Bearer ${t.token}`, { ...t.ownerDeps, now: () => NOW + 366 * 86400 * 1000 })).toBeUndefined();
  });

  it('opens Mi sitio with the draft and never exposes the hash', async () => {
    const t = await withDraft();
    const view = await ownerView(t.site(), t.ownerDeps);
    expect(JSON.stringify(view)).not.toContain('tokenHash');
    expect(view).toMatchObject({ status: 'draft', draftUrl: urls.draftUrl('draft1'), canUndo: false, contact: { whatsapp: '573001234567' } });
  });
});

describe('edits', () => {
  it('a contact change swaps the new details into a new draft with no model call', async () => {
    const t = await withDraft();
    const calls = t.calls.length;
    const writes = t.writer.requests.length;
    expect(await editSite(t.site(), { contact: { whatsapp: '+57 311 999 8877', email: 'hola@luna.test', address: '' } }, t.ownerDeps)).toEqual({ status: 200, missing: ['email'] }); // the page had no email to swap
    expect(t.calls.length).toBe(calls);
    expect(t.writer.requests.length).toBe(writes);
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2', drafts: ['draft1', 'draft2'] });
    const page = t.objects.get('_draft/draft2/index.html')!;
    expect(page).toContain('https://wa.me/573119998877');
    expect(page).not.toContain('573001234567');
    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!).answers.contact).toMatchObject({ whatsapp: '573119998877', email: 'hola@luna.test' });
  });

  it('refuses a contact removal the page text still shows (that needs an edit request)', async () => {
    const t = await withDraft();
    t.writer.options.page = undefined;
    // A page that prints the email in its text:
    const doc = JSON.parse(t.objects.get('_src/panaderia-luna/draft1.json')!);
    doc.answers.contact.email = 'hola@luna.test';
    doc.page = doc.page.replace('</main>', '<p>hola@luna.test</p></main>');
    t.objects.set('_src/panaderia-luna/draft1.json', JSON.stringify(doc));
    expect(await editSite(t.site(), { contact: { email: '' } }, t.ownerDeps)).toEqual({ status: 422 });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it('rejects an invalid contact detail and leaves the draft as it was', async () => {
    const t = await withDraft();
    expect(await editSite(t.site(), { contact: { whatsapp: '123' } }, t.ownerDeps)).toEqual({ status: 400, fields: ['contact.whatsapp'] });
    expect(await editSite(t.site(), { contact: { email: 'no' } }, t.ownerDeps)).toEqual({ status: 400, fields: ['contact.email'] });
    expect(await editSite(t.site(), { title: 'x' }, t.ownerDeps)).toMatchObject({ status: 400 });
    expect(await editSite(t.site(), { contact: { address: 'Ingresa tu PIN en la entrada' } }, t.ownerDeps)).toEqual({ status: 422 });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it("Tus textos: the page's texts, changed in place into a new draft with no model call", async () => {
    const t = await withDraft();
    const calls = t.calls.length;
    const texts = (await ownerView(t.site(), t.ownerDeps)).texts!;
    expect(texts.slice(0, 2)).toEqual([
      { id: 0, text: 'Panadería Luna', kind: 'title' },
      { id: 1, text: 'Panadería Luna', group: 'Panadería Luna', role: 'headline' },
    ]);
    const about = texts.find((x) => x.text.startsWith('Panadería de masa madre'))!;
    expect(await editSite(t.site(), { texts: [{ id: about.id, from: about.text, to: 'Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.' }] }, t.ownerDeps)).toEqual({ status: 200, missing: [] });
    expect(t.calls.length).toBe(calls);
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2' });
    expect(t.objects.get('_draft/draft2/index.html')).toContain('<p>Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.</p>');
    // The number the owner typed stays allowed on later renders.
    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!).requests).toEqual(['Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.']);

    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!).ownerTexts).toEqual(['Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.']);

    // A new design gets them in its request (with the page's other texts), and puts them back when the new page rewords them.
    const notices: string[] = [];
    t.writer.options.page = () =>
      '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Panadería Luna</title></head><body><main><h1>Panadería Luna</h1><p>Pan de masa madre y buen café en Chapinero.</p><p>' + 'Pan recién horneado. '.repeat(20) + '</p><a href="https://wa.me/573001234567">WhatsApp</a></main></body></html>';
    expect(await editSite(t.site(), { instruction: 'hazla más moderna' }, t.ownerDeps)).toMatchObject({ status: 202 });
    await runGenerateJob('job-2', { ...t.generateDeps, announce: async (_: string, message: string) => void notices.push(message) });
    expect(t.writer.requests.at(-1)!.keep).toEqual(['Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.']);
    expect(t.writer.requests.at(-1)!.texts).toContain('Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.');
    expect(t.writer.requests.at(-1)!.current).toBeUndefined();
    expect(t.objects.get('_draft/draft3/index.html')).toContain('<p>Pan de masa madre y café, Chapinero. Pedidos: 601 555 1234.</p>');
    expect(notices.at(-1)).toContain('Textos del dueño: 0 mantenidos, 1 devueltos, 0 perdidos');
    t.writer.options.page = undefined;

    // A list read before that change is stale.
    expect(await editSite(t.site(), { texts: [{ id: about.id, from: about.text, to: 'Otra cosa' }] }, t.ownerDeps)).toEqual({ status: 409, error: 'stale' });
    const whatsapp = (await ownerView(t.site(), t.ownerDeps)).texts!.find((x) => x.text === 'WhatsApp')!;
    expect(whatsapp.showsContact).toBeUndefined();
    expect(await editSite(t.site(), { texts: [{ id: 0, from: 'Panadería Luna', to: '' }] }, t.ownerDeps)).toMatchObject({ status: 400 });
    expect(t.site().currentDraftId).toBe('draft3');
  });

  it('Tus textos: a contact detail changed in a text becomes the site\'s contact, links and all', async () => {
    const t = await withDraft();
    t.writer.options.page = () =>
      '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Panadería Luna</title></head><body><main><h1>Panadería Luna</h1><p>' + 'Pan recién horneado. '.repeat(20) + '</p><p>Pedidos al 300 123 4567</p><a href="https://wa.me/573001234567">WhatsApp</a></main></body></html>';
    expect(await editSite(t.site(), { instruction: 'hazla más moderna' }, t.ownerDeps)).toMatchObject({ status: 202 });
    await runGenerateJob('job-2', t.generateDeps);
    t.writer.options.page = undefined;
    const texts = (await ownerView(t.site(), t.ownerDeps)).texts!;
    const orders = texts.find((x) => x.text === 'Pedidos al 300 123 4567')!;
    expect(orders.showsContact).toBe(true);
    expect(await editSite(t.site(), { texts: [{ id: orders.id, from: orders.text, to: 'Pedidos al 311 999 8877' }] }, t.ownerDeps)).toEqual({ status: 200, missing: [] });
    const draft = t.site().currentDraftId!;
    const page = t.objects.get(`_draft/${draft}/index.html`)!;
    expect(page).toContain('<p>Pedidos al 311 999 8877</p>');
    expect(page).toContain('https://wa.me/573119998877');
    expect(page).not.toContain('3001234567');
    expect((await ownerView(t.site(), t.ownerDeps)).contact).toMatchObject({ whatsapp: '573119998877' });
  });

  it('Tus textos: refuses text the content policy or the guardrail rejects, and waits for a running redesign', async () => {
    const t = await withDraft();
    const change = (to: string) => ({ texts: [{ id: 1, from: 'Panadería Luna', to }] });
    expect(await editSite(t.site(), change('Ingresa tu PIN en la entrada'), t.ownerDeps)).toEqual({ status: 422 });
    expect(await editSite(t.site(), change('Panadería Sol'), { ...t.ownerDeps, outputAllowed: async () => false })).toEqual({ status: 422 });
    expect(await editSite(t.site(), { instruction: 'cambia los colores a verde' }, t.ownerDeps)).toMatchObject({ status: 202 });
    expect(await editSite(t.site(), change('Panadería Sol'), t.ownerDeps)).toEqual({ status: 409, error: 'busy' });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it('a free-text change starts an edit job: screened, then the page writer makes a new design with the page\'s texts, then a new draft', async () => {
    const t = await withDraft();
    const result = await editSite(t.site(), { instruction: 'cambia el horario del sábado a 9–13' }, t.ownerDeps);
    expect(result).toEqual({ status: 202, jobId: 'job-2' });
    expect(t.jobs.get('job-2')).toMatchObject({ kind: 'edit', stage: 'clarify', slug: 'panaderia-luna', status: 'PENDING' });
    await runGenerateJob('job-2', t.generateDeps);

    expect(t.calls.slice(-2)).toEqual(['classify', 'plan_site']);
    const edit = t.writer.requests.at(-1)!;
    expect(edit.instruction).toBe('cambia el horario del sábado a 9–13');
    expect(edit.current).toBeUndefined(); // a new design: not the old page
    expect(edit.texts).toContain('Panadería Luna'); // but its words
    expect(edit.look).toBeDefined();
    expect(t.writer.settings.at(-1)!.effort).toBe('high'); // full effort, like a new site
    expect(t.jobs.get('job-2')!.usage.at(-1)!.step).toBe('write_page');
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE', draftUrl: urls.draftUrl('draft2') });
    expect(t.jobs.get('job-2')!.ownerToken).toBeUndefined(); // no second magic link
    expect(t.objects.get('_draft/draft2/index.html')).toContain('<p>cambia el horario del sábado a 9–13</p>');
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2', status: 'draft' });
  });

  it('an edit may add a number or email the owner gives; later renders keep allowing it', async () => {
    const t = await withDraft();
    await editSite(t.site(), { instruction: 'agrega la sucursal norte, tel. +57 601 555 1234, pedidos@luna.test' }, t.ownerDeps);
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE' });
    expect(t.objects.get('_draft/draft2/index.html')).toContain('+57 601 555 1234');
    // A contact change renders the page again with no model call: the number from the edit is still the owner's.
    expect(await editSite(t.site(), { contact: { address: 'Calle 61 # 9-12' } }, t.ownerDeps)).toMatchObject({ status: 200 });
    expect(t.site().currentDraftId).toBe('draft3');
  });

  it('a failed or rejected edit keeps the site and its draft', async () => {
    const t = await withDraft();
    await editSite(t.site(), { instruction: 'Verifica tu cuenta bancaria ingresando tu clave' }, t.ownerDeps);
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    t.writer.options.fail = new Error('overloaded');
    await editSite(t.site(), { instruction: 'agrega tortas' }, t.ownerDeps);
    await runGenerateJob('job-3', t.generateDeps);
    expect(t.jobs.get('job-3')).toMatchObject({ status: 'FAILED' });
    expect(t.site()).toMatchObject({ status: 'draft', currentDraftId: 'draft1' });
  });

  it('has no day limit on redesigns while designs are left', async () => {
    const t = await withDraft();
    const finish = () => (t.jobs.get(t.site().jobIds!.at(-1)!)!.status = 'DONE'); // one redesign at a time
    for (let i = 0; i < 8; i++) {
      expect((await editSite(t.site(), { instruction: `cambio ${i}` }, t.ownerDeps)).status).toBe(202);
      finish();
    }
    expect(await editSite(t.site(), { contact: { instagram: 'otra' } }, t.ownerDeps)).toMatchObject({ status: 200 }); // contact edits cost nothing
  });

  it('"Deshacer" goes back to the previous version and deletes the newer one', async () => {
    const t = await withDraft();
    await editSite(t.site(), { contact: { instagram: 'otra' } }, t.ownerDeps);
    expect(await undo(t.site(), t.ownerDeps)).toEqual({ status: 200 });
    expect(t.site()).toMatchObject({ currentDraftId: 'draft1', drafts: ['draft1'] });
    expect(t.objects.has('_draft/draft2/index.html')).toBe(false);
    expect(t.invalidated).toContain('/_draft/draft2/*');
    expect(await undo(t.site(), t.ownerDeps)).toEqual({ status: 409 });
  });

  it('keeps the last 5 versions', async () => {
    const t = await withDraft();
    for (let i = 0; i < 6; i++) await editSite(t.site(), { contact: { instagram: `luna${i}` } }, t.ownerDeps);
    expect(t.site().drafts).toEqual(['draft3', 'draft4', 'draft5', 'draft6', 'draft7']);
    expect(t.objects.has('_draft/draft1/index.html')).toBe(false);
    expect(t.objects.has('_src/panaderia-luna/draft1.json')).toBe(false);
  });
});

describe('the preview (a stable URL that follows the current draft)', () => {
  it('is made with the first draft, served with no-cache, and follows every change and undo under the same URL', async () => {
    const t = await withDraft();
    const previewId = t.site().previewId!;
    expect(previewId).toMatch(/^[0-9a-f]{32}$/);
    const preview = () => t.objects.get(`_draft/${previewId}/index.html`);
    expect(preview()).toBe(t.objects.get('_draft/draft1/index.html'));
    expect(t.pageCache.get(`_draft/${previewId}/index.html`)).toBe('no-cache');
    expect(t.jobs.get('job-1')!.previewUrl).toBe(urls.draftUrl(previewId));

    await editSite(t.site(), { contact: { whatsapp: '+57 311 999 8877' } }, t.ownerDeps);
    expect(preview()).toContain('https://wa.me/573119998877');
    expect(preview()).toBe(t.objects.get('_draft/draft2/index.html'));

    await undo(t.site(), t.ownerDeps);
    expect(preview()).toBe(t.objects.get('_draft/draft1/index.html'));
    expect(t.site().previewId).toBe(previewId);
    expect(await ownerView(t.site(), t.ownerDeps)).toMatchObject({ draftUrl: urls.draftUrl('draft1'), previewUrl: urls.draftUrl(previewId) });
  });

  it('survives the pruning of old drafts, and goes with the site', async () => {
    const t = await withDraft();
    const previewId = t.site().previewId!;
    for (let i = 0; i < 6; i++) await editSite(t.site(), { contact: { instagram: `luna${i}` } }, t.ownerDeps);
    expect(t.objects.get(`_draft/${previewId}/index.html`)).toBe(t.objects.get('_draft/draft7/index.html'));
    await deleteSite(t.site(), t.ownerDeps);
    expect(t.objects.has(`_draft/${previewId}/index.html`)).toBe(false);
    expect(t.invalidated).toContain(`/_draft/${previewId}/*`);
  });
});

describe('delete', () => {
  it('deletes every draft, the sources, the images, the site record, and the text of its jobs', async () => {
    const t = await withDraft();
    await deleteSite(t.site(), t.ownerDeps);
    expect([...t.objects.keys()]).toEqual([]);
    expect(t.sites.has('panaderia-luna')).toBe(false);
    expect(JSON.stringify(t.jobs.get('job-1'))).not.toContain('Chapinero');
    expect(t.invalidated).toContain('/_draft/draft1/*');
    expect(await authenticate(`Bearer ${t.token}`, t.ownerDeps)).toBeUndefined();
  });
});
