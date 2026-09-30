import { describe, expect, it } from 'vitest';
import { CHAT_MESSAGES_PER_DAY, chatView, postChat, runChatTurn } from '../src/core/chat';
import { runGenerateJob } from '../src/core/generate-job';
import { authenticate, deleteSite, editSite, POLL_CAP } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { body, harness, NOW, urls } from './harness';

const ABOUT = 'Panadería de masa madre en Chapinero, Bogotá.';

/** A site with its first draft, plus the owner's token. */
async function withDraft(model: Parameters<typeof harness>[0] = {}) {
  const t = harness(model);
  await submit(body, '1.2.3.4', t.submitDeps);
  await runGenerateJob('job-1', t.generateDeps);
  const token = (await t.stores.takeOwnerToken('job-1'))!;
  const site = () => t.sites.get('panaderia-luna')!;
  /** Sends a message and runs the reply, the way the owner and chat Lambdas do. */
  const send = async (text: string) => {
    const posted = await postChat(site(), { text }, t.ownerDeps);
    if (posted.status !== 202) throw new Error(`postChat: ${posted.status}`);
    const outcome = await runChatTurn('panaderia-luna', t.chats.at(-1)!.at, t.chatDeps);
    return { posted, outcome, reply: t.chat.at(-1)! };
  };
  return { ...t, token, site, send };
}

describe('chat', () => {
  it('a text change: Haiku gets an outline with stand-in numbers, its changes make a new draft', async () => {
    const t = await withDraft({ chat: { action: 'edit', reply: 'Listo, agregué los domingos.', changes: [{ find: ABOUT, replace: `${ABOUT} Abrimos también los domingos.` }] } });
    const { posted, outcome, reply } = await t.send('abrimos también los domingos');
    expect(posted).toMatchObject({ status: 202, messages: [{ role: 'owner', status: 'done' }, { role: 'coyote', status: 'pending' }] });
    expect(outcome).toMatchObject({ outcome: 'EDITED' });
    expect(t.calls.slice(-2)).toEqual(['classify', 'edit_page']);
    const request = t.requests.at(-1)!;
    expect(request.guarded).toContain('<request>abrimos también los domingos</request>');
    expect(request.user).toContain('<h1>Panadería Luna</h1>');
    expect(request.user).not.toContain('573001234567');
    expect(reply).toMatchObject({ role: 'coyote', status: 'done', text: 'Listo, agregué los domingos.', draftId: 'draft2' });
    expect(t.site()).toMatchObject({ currentDraftId: 'draft2' });
    const page = t.objects.get('_draft/draft2/index.html')!;
    expect(page).toContain('Abrimos también los domingos.');
    expect(page).toContain('https://wa.me/573001234567'); // the real number is back
    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!).requests).toEqual(['abrimos también los domingos']);
    expect(t.writer.requests).toHaveLength(1); // no page writer call
  });

  it('a new number the owner wrote goes through the contact change; one the model made up is dropped', async () => {
    const t = await withDraft({ chat: { action: 'edit', reply: 'Listo, cambié tu WhatsApp.', contact: { whatsapp: '+57 311 999 8877' } } });
    await t.send('mi nuevo whatsapp es +57 311 999 8877');
    expect(t.objects.get('_draft/draft2/index.html')).toContain('https://wa.me/573119998877');
    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft2.json')!).answers.contact.whatsapp).toBe('573119998877');

    const u = await withDraft({ chat: { action: 'edit', reply: 'Listo.', contact: { whatsapp: '+57 311 999 8877' } } });
    const { reply } = await u.send('cambia mi número de WhatsApp');
    expect(reply.draftId).toBeUndefined();
    expect(u.site().currentDraftId).toBe('draft1');
  });

  it('a design change gets a redesign offer and no draft', async () => {
    const t = await withDraft({ chat: { action: 'redesign', reply: 'Eso necesita un rediseño de la página.', instruction: 'Cambia los colores del sitio a tonos verdes.' } });
    const { reply } = await t.send('pon todo en verde');
    expect(reply).toMatchObject({ status: 'done', redesign: 'Cambia los colores del sitio a tonos verdes.' });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it('a question or a greeting is only a reply', async () => {
    const t = await withDraft();
    const { outcome, reply } = await t.send('hola');
    expect(outcome).toMatchObject({ outcome: 'REPLIED' });
    expect(reply).toMatchObject({ text: '¡Hola! ¿Qué quieres cambiar?', status: 'done' });
    expect(t.site().currentDraftId).toBe('draft1');
  });

  it('the pre-screen and the page checks can stop a change', async () => {
    const t = await withDraft();
    t.options.classify = 'reject';
    const { outcome, reply } = await t.send('pon que vendemos cerveza artesanal');
    expect(outcome).toMatchObject({ outcome: 'REJECTED' });
    expect(reply.text).toContain('reglas de uso');
    expect(t.calls).not.toContain('edit_page');

    // A number nobody gave: the page checks refuse it.
    const u = await withDraft({ chat: { action: 'edit', reply: 'Listo.', changes: [{ find: ABOUT, replace: `${ABOUT} Llama al +57 601 999 1234.` }] } });
    const second = await u.send('agrega un teléfono');
    expect(second.reply).toMatchObject({ status: 'done', redesign: 'agrega un teléfono' });
    expect(u.site().currentDraftId).toBe('draft1');
  });

  it('changes that do not apply get one retry with the problems, then a redesign offer', async () => {
    const t = await withDraft({ chat: { action: 'edit', reply: 'Listo.', changes: [{ find: 'Pan', replace: 'Pan rico' }] } });
    const { reply } = await t.send('cambia pan por pan rico');
    expect(t.calls.filter((c) => c === 'edit_page')).toHaveLength(2);
    expect(t.requests.at(-1)!.user).toContain('found');
    expect(reply).toMatchObject({ redesign: 'cambia pan por pan rico' });
    expect(t.site().currentDraftId).toBe('draft1');

    const u = await withDraft({
      chat: (call) => ({ action: 'edit', reply: 'Listo.', changes: [{ find: call === 1 ? 'Pan' : '<h1>Panadería Luna</h1>', replace: '<h1>Panadería Luna 🌙</h1>' }] }),
    });
    await u.send('agrega una luna al título');
    expect(u.objects.get('_draft/draft2/index.html')).toContain('Panadería Luna 🌙');
  });

  it('one reply at a time, never during a page writer edit, and a daily cap', async () => {
    const t = await withDraft();
    expect(await postChat(t.site(), { text: 'hola' }, t.ownerDeps)).toMatchObject({ status: 202 });
    expect(await postChat(t.site(), { text: 'hola otra vez' }, t.ownerDeps)).toEqual({ status: 409, error: 'busy' });
    await runChatTurn('panaderia-luna', t.chats.at(-1)!.at, t.chatDeps);
    expect(await postChat(t.site(), { text: '' }, t.ownerDeps)).toEqual({ status: 400 });

    const u = await withDraft();
    await editSite(u.site(), { instruction: 'cambia los colores' }, u.ownerDeps);
    expect(await postChat(u.site(), { text: 'hola' }, u.ownerDeps)).toEqual({ status: 409, error: 'busy' });

    const w = await withDraft();
    for (let i = 0; i < CHAT_MESSAGES_PER_DAY; i++) {
      await w.send(`mensaje ${i}`);
    }
    expect(await postChat(w.site(), { text: 'uno más' }, w.ownerDeps)).toEqual({ status: 429 });
  });

  it('the view: the first load has the header, polls only what changed, and a stuck reply reads as failed', async () => {
    const t = await withDraft();
    await postChat(t.site(), { text: 'hola' }, t.ownerDeps);
    const first = await chatView(t.site(), undefined, t.ownerDeps);
    expect(first).toMatchObject({ businessName: 'Panadería Luna', lang: 'es', canChat: true, draftUrl: urls.draftUrl('draft1'), canUndo: false });
    expect(first.messages.map((m) => m.status)).toEqual(['done', 'pending']);
    const poll = await chatView(t.site(), NOW, t.ownerDeps);
    expect(poll).not.toHaveProperty('businessName');
    expect(poll.messages).toHaveLength(1); // only the reply, after the owner's message
    const later = await chatView(t.site(), NOW, { ...t.ownerDeps, now: () => NOW + 4 * 60 * 1000 });
    expect(later.messages[0]!.status).toBe('failed');
  });

  it('polling has its own cap, and deleting the site deletes the chat', async () => {
    const t = await withDraft();
    await authenticate(`Bearer ${t.token}`, t.ownerDeps, POLL_CAP);
    expect([...t.counters.keys()]).toContain(`poll#panaderia-luna#${new Date(NOW).toISOString().slice(0, 10)}`);
    await t.send('hola');
    expect(t.chat).toHaveLength(2);
    await deleteSite(t.site(), t.ownerDeps);
    expect(t.chat).toHaveLength(0);
  });
});
