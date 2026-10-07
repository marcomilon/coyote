import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { checkPage, contactMissing, replaceContact } from '../src/core/page-check';
import { pageModel, pageParams, pagePrompt, parsePage, pickLook, TONES, type PageRequest } from '../src/core/page-writer';
import { submit } from '../src/core/submit';
import { body, harness } from './harness';

const contact = { whatsapp: '573001234567', address: 'Calle 60 # 9-12', instagram: 'luna.pan' };
const links = { reportUrl: 'https://app.test/reportar?sitio=x', privacyUrl: 'https://app.test/privacidad' };
const opts = { contact, businessName: 'Panadería Luna', lang: 'es' as const, ...links };

const doc = (body: string, head = '') =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Panadería Luna</title>${head}</head><body>${body}</body></html>`;

describe('checkPage', () => {
  it('keeps the owner\'s links, CDN scripts, and a Google map; adds the overflow guard and the footer', () => {
    const page = doc(
      `<h1>Panadería Luna</h1><a href="https://wa.me/573001234567?text=Hola">Pedir</a><a href="https://instagram.com/luna.pan/">IG</a>
       <a href="https://www.google.com/maps/search/?api=1&query=Calle">Cómo llegar</a><a href="#menu">Menú</a>
       <iframe src="https://maps.google.com/maps?q=Calle%2060&z=16&output=embed"></iframe><img src="assets/hero.jpg" alt="Pan">
       <script>document.querySelector('h1').classList.add('on')</script>`,
      '<script src="https://cdn.tailwindcss.com"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces">',
    );
    const result = checkPage(page, opts);
    expect(result.violations).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(result.html).toContain('https://wa.me/573001234567?text=Hola');
    expect(result.html).toContain('<iframe src="https://maps.google.com/maps?q=');
    expect(result.html).toContain('overflow-x:clip');
    expect(result.html).toMatch(/Sitio creado con ventas314.com · <a href="https:\/\/app\.test\/reportar\?sitio=x"/);
    expect(result.texts).toContain('Panadería Luna');
    expect(result.texts).toContain('Pan'); // alt text is visible text
  });

  it('repairs what it can: other links, outside images and scripts, other iframes, form actions', () => {
    const result = checkPage(
      doc(`<a href="https://evil.test/login">x</a><a href="https://wa.me/5491100000000">y</a><img src="https://images.unsplash.com/p.jpg">
           <script src="https://evil.test/x.js"></script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><button>Enviar</button></form><base href="https://evil.test/">`),
      opts,
    );
    expect(result.violations).toEqual([]);
    expect(result.html).not.toContain('evil.test');
    expect(result.html).not.toContain('unsplash');
    expect(result.html).not.toContain('5491100000000');
    expect(result.repairs.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects what it cannot repair: redirects, someone else\'s number or email, scam text', () => {
    const codes = (body: string) => checkPage(doc(body), opts).violations.map((v) => v.detail);
    expect(codes('<script>window.location = "https://evil.test"</script>')).not.toEqual([]);
    expect(codes('<script>open("https://wa.me/5491100000000")</script>')).not.toEqual([]);
    expect(codes('<p>Llámanos al +54 9 11 5555 0000</p>')).not.toEqual([]);
    expect(codes('<p>Escríbenos a otro@correo.test</p>')).not.toEqual([]);
    expect(codes('<p>Verifica tu cuenta bancaria ingresando tu clave</p>')).not.toEqual([]);
    expect(checkPage(doc('<meta http-equiv="refresh" content="0;url=https://evil.test">'), opts).violations).not.toEqual([]);
  });

  it('allows numbers and emails the owner wrote outside the contact answers, in any format', () => {
    const ownerText = 'Sucursal centro: +54 11 4555-1234. Pedidos por mayor a Pedidos@Luna.test o al WhatsApp 11 5555 9876';
    const page = doc(`<p>Sucursal centro: 11 4555 1234</p><a href="tel:+541145551234">Llamar</a><a href="mailto:pedidos@luna.test">Mail</a>
      <a href="https://wa.me/5491155559876">Mayoristas</a><p>pedidos@luna.test</p>`);
    const result = checkPage(page, { ...opts, ownerText });
    expect(result.violations).toEqual([]);
    expect(result.repairs).toEqual([]);
    // Without the owner's text, the same page is someone else's contact details.
    expect(checkPage(page, opts).violations).not.toEqual([]);
    // A number the owner never gave is still rejected.
    expect(checkPage(doc('<p>Llámanos al +54 9 11 5555 0000</p>'), { ...opts, ownerText }).violations).not.toEqual([]);
  });

  it('does not mistake years, prices, or SVG paths for phone numbers', () => {
    const result = checkPage(
      doc(`<p>Desde 2019 – 2024 · $12.500</p><p>Tel. +57 300 123 4567</p><svg><path d="M4 -15 A15 15 0 1 1 4 15"/></svg>
           <script>const d = 'M4 -15 A15 15 0 1 1 4 15'; const t = [15, 0, 1, 1, 4, 15];</script>`),
      opts,
    );
    expect(result.violations).toEqual([]);
  });
});

describe('contact details on a written page', () => {
  it('a contact change swaps the number in links, scripts, and formatted text, keeping the formatting', () => {
    const after = { ...contact, whatsapp: '573119998877' };
    const page = `<a href="https://wa.me/573001234567">+57 300 123 4567</a><script>const n='573001234567'</script><p>300 123 4567</p>`;
    const out = replaceContact(page, contact, after);
    expect(out).toBe(`<a href="https://wa.me/573119998877">+57 311 999 8877</a><script>const n='573119998877'</script><p>311 999 8877</p>`);
  });

  it('finds an Argentine mobile with or without its 9', () => {
    const before = { whatsapp: '5493593834943' };
    const after = { whatsapp: '5491123456789' };
    const out = replaceContact('<a href="https://wa.me/5493593834943">+54 9 3593 83-4943</a><p>3593 834943</p>', before, after);
    expect(out).toBe('<a href="https://wa.me/5491123456789">+54 9 1123 45-6789</a><p>1123 456789</p>');
  });

  it('finds an address however the page wrote it, and says when a changed detail is not on the page', () => {
    const before = { whatsapp: '51977204162', address: 'av. bolivar 244, pueblo libre', email: 'a@b.pe' };
    const after = { ...before, address: 'av. bolivar 666, pueblo libre' };
    const page = '<p class="contact-link">Av. Bolívar 244<br>Pueblo Libre</p><footer>📍 Av. Bolívar 244, Pueblo Libre • a@b.pe</footer><p>Bolívar fue un prócer.</p>';
    const out = replaceContact(page, before, after);
    expect(out).toBe('<p class="contact-link">av. bolivar 666, pueblo libre</p><footer>📍 av. bolivar 666, pueblo libre • a@b.pe</footer><p>Bolívar fue un prócer.</p>');
    expect(contactMissing(out, before, after)).toEqual([]);
    // A page that never showed the address, and a new email it never had: both reported.
    expect(contactMissing('<p>Hola</p>', before, { ...after, email: 'nuevo@b.pe' })).toEqual(['email', 'address']);
  });

  it("finds a number written with non-breaking spaces or hyphens, and the owner's 13-digit number is not a card", () => {
    const before = { whatsapp: '5493593834943' };
    const after = { whatsapp: '5491123456789' };
    for (const gap of ['&nbsp;', '&#160;', '\u00a0', '\u2011']) {
      const written = `<p>WhatsApp: +54${gap}9${gap}3593${gap}834943</p>`;
      expect(checkPage(`<!doctype html><html><head><title>Panadería Luna</title></head><body><h1>Panadería Luna</h1>${written}</body></html>`, { ...opts, contact: before }).violations).toEqual([]);
      expect(replaceContact(written, before, after)).toBe(`<p>WhatsApp: +54${gap}9${gap}1123${gap}456789</p>`);
    }
  });

  it('the prompt carries the owner\'s real contact details', () => {
    const request: PageRequest = { answers: { businessName: 'Panadería Luna', about: 'Pan', lang: 'es', contact }, notes: [], photos: [] };
    expect(pagePrompt(request)).toContain('573001234567');
    expect(pagePrompt(request)).toContain('frontend-design skill');
  });

  it('nudges each new site toward three different tones and a light or dark page, usually without a ticker strip', () => {
    let n = 0;
    const seq = [0.99, 0.99, 0.99, 0.1, 0.9];
    const look = pickLook(() => seq[n++]!);
    expect(new Set(look.tones).size).toBe(3);
    expect(look.tones.every((t) => (TONES as readonly string[]).includes(t))).toBe(true);
    expect(look).toMatchObject({ dark: true, noTicker: false });
    const answers = { businessName: 'Luna', about: 'Pan', lang: 'es' as const, contact };
    expect(pagePrompt({ answers, notes: [], photos: [], look })).toContain(`go with whichever of these suits the business best: ${look.tones.join(', ').replace(/, ([^,]+)$/, ', or $1')}, on a dark background.`);
    expect(pagePrompt({ answers, notes: [], photos: [], look: { ...look, noTicker: true } })).toContain('on a dark background, without a scrolling ticker or marquee strip.');
    expect(pagePrompt({ answers, notes: [], photos: [], current: '<html></html>', instruction: 'x' })).not.toContain('For the look');
  });

  it('picks the model from the page-model switch, with PAGE_MODEL over it and Opus by default', () => {
    expect(pageModel({}, 'haiku')).toBe('claude-haiku-4-5');
    expect(pageModel({}, 'opus')).toBe('claude-opus-5-5');
    expect(pageModel({}, undefined)).toBe('claude-opus-5-5');
    expect(pageModel({}, 'toString')).toBe('claude-opus-5-5');
    expect(pageModel({ PAGE_MODEL: 'claude-x' }, 'haiku')).toBe('claude-x');
  });

  it('sends the effort setting to Opus but not to Haiku 4.5, which rejects it', () => {
    const request = { answers: { businessName: 'Luna', about: 'Pan', lang: 'es' as const, contact }, notes: [], photos: [] };
    expect(pageParams(request, 'claude-opus-5-5', 'high')).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } });
    expect(pageParams(request, 'claude-haiku-4-5', 'high')).not.toHaveProperty('output_config');
  });

  it('reads the last html block or a bare document', () => {
    const page = doc('<p>' + 'x'.repeat(600) + '</p>');
    expect(parsePage(`Aquí está:\n\`\`\`html\n${page}\n\`\`\`\nListo.`)).toBe(page);
    expect(parsePage(`Texto antes ${page} y después`)).toBe(page);
    expect(parsePage('```html\n<p>corto</p>\n```')).toBeUndefined();
  });
});

describe('runGenerateJob with the page writer', () => {
  it('a new site is written by the page writer alone: no theme content, no hero image', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });
    expect(t.calls).not.toContain('design_brief');
    expect(t.calls).not.toContain('publish_content');
    expect([...t.objects.keys()].some((k) => k.includes('hero'))).toBe(false);
    expect(t.writer.requests[0]!.photos).toEqual([]);
    expect(t.writer.requests[0]!.look!.tones).toHaveLength(3);
  });

  it('writes with the model it is given, for new sites and edits alike', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.generateDeps, pageModel: 'claude-haiku-4-5' });
    expect(t.writer.settings[0]).toEqual({ effort: 'high', model: 'claude-haiku-4-5' });
  });

  it('fails the job, and frees the slug, when the page writer fails or sends no page', async () => {
    for (const options of [{ fail: new Error('overloaded') }, { page: () => 'no page' }]) {
      const t = harness();
      Object.assign(t.writer.options, options);
      await submit(body, '1.2.3.4', t.submitDeps);
      expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'FAILED' });
      expect(t.jobs.get('job-1')!.error).toContain('page writer failed');
      expect(t.sites.size).toBe(0);
    }
  });

  it('keeps a number and email the owner wrote in the description', async () => {
    const t = harness();
    await submit({ ...body, about: `${body.about} Sucursal norte: +57 601 555 1234, pedidos@luna.test` }, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });
  });

  it('rejects the job when the page has someone else\'s phone number or the guardrail blocks it', async () => {
    const t = harness();
    t.writer.options.page = (r) => `<!doctype html><html><head><title>x</title></head><body><h1>${r.answers.businessName}</h1><p>Llámanos al +54 9 11 5555 0000</p><p>${'pan '.repeat(200)}</p></body></html>`;
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });

    const u = harness();
    await submit(body, '1.2.3.4', u.submitDeps);
    await runGenerateJob('job-1', { ...u.generateDeps, outputAllowed: async () => false });
    expect(u.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'guardrail' });
  });
});
