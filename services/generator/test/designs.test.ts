import { describe, expect, it } from 'vitest';
import { loadDraft, MAX_DESIGNS, saveDraft } from '../src/core/drafts';
import { runGenerateJob } from '../src/core/generate-job';
import { chooseDesign, deleteSite, editSite, ownerView, undo } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { body, harness } from './harness';

async function withDesigns() {
  const t = harness();
  await submit(body, '1.2.3.4', t.submitDeps);
  await runGenerateJob('job-1', t.generateDeps);
  const site = () => t.sites.get('panaderia-luna')!;
  await editSite(site(), { instruction: 'hazla más moderna' }, t.ownerDeps);
  await runGenerateJob('job-2', t.generateDeps);
  return { ...t, site };
}

describe('designs', () => {
  it('a redesign is a new design and keeps the old one; updates stay with their design', async () => {
    const t = await withDesigns();
    expect(t.site().designs).toEqual([
      { id: 'draft1', draftId: 'draft1', at: expect.any(Number), kind: 'create' },
      { id: 'draft2', draftId: 'draft2', at: expect.any(Number), kind: 'redesign', request: 'hazla más moderna' },
    ]);
    const view = await ownerView(t.site(), t.ownerDeps);
    expect(view.designs!.map((d) => [d.id, d.current])).toEqual([['draft1', false], ['draft2', true]]);

    // A contact edit is an update of the current design.
    expect((await editSite(t.site(), { contact: { address: 'Calle 1' } }, t.ownerDeps)).status).toBe(200);
    expect(t.site().designs!.map((d) => d.draftId)).toEqual(['draft1', 'draft3']);
    expect((await loadDraft('panaderia-luna', 'draft3', t.stores)).design).toBe('draft2');
  });

  it('choosing a design brings its page back as a new version, with no model call, and the chat says so', async () => {
    const t = await withDesigns();
    const writes = t.writer.requests.length;
    const calls = t.calls.length;
    expect(await chooseDesign(t.site(), { design: 'draft1' }, t.ownerDeps)).toEqual({ status: 200 });
    expect(t.writer.requests).toHaveLength(writes);
    expect(t.calls).toHaveLength(calls);
    expect(t.site().currentDraftId).toBe('draft3');
    expect((await loadDraft('panaderia-luna', 'draft3', t.stores)).page).toBe((await loadDraft('panaderia-luna', 'draft1', t.stores)).page);
    expect(t.site().designs!.map((d) => [d.id, d.draftId])).toEqual([['draft1', 'draft3'], ['draft2', 'draft2']]);
    expect(t.chat.at(-1)).toMatchObject({ role: 'coyote', draftId: 'draft3', text: expect.stringContaining('diseño que elegiste') });

    // Updates now go to the chosen design; the other one stays as it was.
    await editSite(t.site(), { contact: { address: 'Calle 1' } }, t.ownerDeps);
    expect(t.site().designs!.map((d) => [d.id, d.draftId])).toEqual([['draft1', 'draft4'], ['draft2', 'draft2']]);
    expect(await chooseDesign(t.site(), { design: 'nope' }, t.ownerDeps)).toEqual({ status: 404 });
  });

  it('a redesign hears what the current page looks like, gets another look, and keeps its look', async () => {
    const t = await withDesigns();
    const [first, second] = t.writer.requests;
    expect(first!.avoid).toBeUndefined();
    expect(second!.avoid).toMatchObject({ fonts: expect.any(Array), colors: expect.any(Array) });
    expect(second!.look!.tones.some((tone) => first!.look!.tones.includes(tone))).toBe(false);
    expect(second!.look!.dark).toBe(!first!.look!.dark);
    expect((await loadDraft('panaderia-luna', 'draft2', t.stores)).look).toEqual({ tones: second!.look!.tones, dark: second!.look!.dark });
  });

  it('waits for a running redesign', async () => {
    const t = await withDesigns();
    await editSite(t.site(), { instruction: 'colores verdes' }, t.ownerDeps);
    expect(await chooseDesign(t.site(), { design: 'draft1' }, t.ownerDeps)).toEqual({ status: 409, error: 'busy' });
  });

  it('undo of a new design removes it; undo of an update moves its design back', async () => {
    const t = await withDesigns();
    await editSite(t.site(), { contact: { address: 'Calle 1' } }, t.ownerDeps);
    expect(await undo(t.site(), t.ownerDeps)).toEqual({ status: 200 });
    expect(t.site().designs!.map((d) => [d.id, d.draftId])).toEqual([['draft1', 'draft1'], ['draft2', 'draft2']]);
    expect(await undo(t.site(), t.ownerDeps)).toEqual({ status: 200 });
    expect(t.site().designs!.map((d) => d.id)).toEqual(['draft1']);
    expect(t.objects.has('_src/panaderia-luna/draft2.json')).toBe(false);
  });

  it('keeps every design past the last 5 versions, up to MAX_DESIGNS, and deletes them with the site', async () => {
    const t = await withDesigns();
    for (let i = 0; i < 6; i++) await editSite(t.site(), { contact: { address: `Calle ${i}` } }, t.ownerDeps);
    expect(t.site().drafts).not.toContain('draft1');
    expect(t.objects.has('_src/panaderia-luna/draft1.json')).toBe(true); // the first design's latest version
    expect(t.objects.has('_src/panaderia-luna/draft2.json')).toBe(false); // an old version of the second design

    const doc = await loadDraft('panaderia-luna', t.site().currentDraftId!, t.stores);
    for (let i = 0; i < MAX_DESIGNS; i++) await saveDraft(t.site(), doc, t.generateDeps, { kind: 'redesign', request: `diseño ${i}` });
    expect(t.site().designs).toHaveLength(MAX_DESIGNS);
    expect(t.site().designs!.map((d) => d.id)).not.toContain('draft1');
    expect(t.objects.has('_src/panaderia-luna/draft1.json')).toBe(false);

    const kept = t.site().designs!.map((d) => d.draftId);
    await deleteSite(t.site(), t.ownerDeps);
    for (const id of kept) expect(t.objects.has(`_src/panaderia-luna/${id}.json`)).toBe(false);
  });
});
