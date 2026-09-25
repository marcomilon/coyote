import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { authenticate, deleteSite, EDITS_PER_DAY, editSite, ownerView, undo } from '../src/core/owner';
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
  it('a contact change refills the placeholders into a new draft, with no model call', async () => {
    const t = await withDraft();
    const calls = t.calls.length;
    expect(await editSite(t.site(), { contact: { instagram: '@luna.pan', email: 'hola@luna.test', address: '' } }, t.ownerDeps)).toEqual({ status: 200 });
    expect(t.calls.length).toBe(calls);
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2', drafts: ['draft1', 'draft2'] });
    const page = t.objects.get('_draft/draft2/index.html')!;
    expect(page).toContain('https://instagram.com/luna.pan');
    expect(page).toContain('href="mailto:hola@luna.test"');
    expect(page).not.toContain('Cómo llegar'); // no address: the directions button and the map go
    expect(page).not.toContain('maps.google.com');
  });

  it('rejects an invalid contact detail and leaves the draft as it was', async () => {
    const t = await withDraft();
    expect(await editSite(t.site(), { contact: { whatsapp: '123' } }, t.ownerDeps)).toEqual({ status: 400, fields: ['contact.whatsapp'] });
    expect(await editSite(t.site(), { contact: { email: 'no' } }, t.ownerDeps)).toEqual({ status: 400, fields: ['contact.email'] });
    expect(await editSite(t.site(), { title: 'x' }, t.ownerDeps)).toMatchObject({ status: 400 });
    expect(await editSite(t.site(), { contact: { address: 'Ingresa tu PIN en la entrada' } }, t.ownerDeps)).toEqual({ status: 422 });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it('a free-text change starts an edit job: screened, then edit_site on the current source, then a new draft', async () => {
    const t = await withDraft();
    const result = await editSite(t.site(), { instruction: 'cambia el horario del sábado a 9–13' }, t.ownerDeps);
    expect(result).toEqual({ status: 202, jobId: 'job-2' });
    expect(t.jobs.get('job-2')).toMatchObject({ kind: 'edit', stage: 'clarify', slug: 'panaderia-luna', status: 'PENDING' });
    await runGenerateJob('job-2', t.generateDeps);

    expect(t.calls.slice(-3)).toEqual(['classify', 'plan_site', 'edit_site']);
    const edit = t.requests.at(-1)!;
    expect(edit.guarded).toContain('<request>\ncambia el horario del sábado a 9–13\n</request>');
    expect(edit.user).toContain('{{whatsapp_url}}'); // the current source, with placeholders
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'DONE', draftUrl: urls.draftUrl('draft2') });
    expect(t.jobs.get('job-2')!.ownerToken).toBeUndefined(); // no second magic link
    expect(t.objects.get('_draft/draft2/index.html')).toContain('Nuestro pan de cada día');
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2', status: 'draft' });
  });

  it('a failed or rejected edit keeps the site and its draft', async () => {
    const t = await withDraft();
    t.options.edited = t.objects.get('_src/panaderia-luna/draft1.html')!.replace('</main>', '<p>Verifica tu cuenta hoy.</p></main>');
    await editSite(t.site(), { instruction: 'agrega un aviso' }, t.ownerDeps);
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    expect(t.site()).toMatchObject({ status: 'draft', currentDraftId: 'draft1' });
  });

  it(`caps free-text edits at ${EDITS_PER_DAY} a day`, async () => {
    const t = await withDraft();
    for (let i = 0; i < EDITS_PER_DAY; i++) expect((await editSite(t.site(), { instruction: `cambio ${i}` }, t.ownerDeps)).status).toBe(202);
    expect(await editSite(t.site(), { instruction: 'uno más' }, t.ownerDeps)).toEqual({ status: 429 });
    expect(await editSite(t.site(), { contact: { instagram: 'otra' } }, t.ownerDeps)).toEqual({ status: 200 }); // contact edits cost nothing
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
    expect(t.objects.has('_src/panaderia-luna/draft1.html')).toBe(false);
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
