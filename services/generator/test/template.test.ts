import { describe, expect, it } from 'vitest';
import type { Answers } from '../src/core/answers';
import { runGenerateJob } from '../src/core/generate-job';
import { editSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { body, harness } from './harness';
import { toolInputOf } from '../src/core/bedrock';
import { checkPage } from '../src/core/page-check';
import { displayPhone, fillSchema, fillTemplate, parseTemplate, type StoredFill } from '../src/core/template';

const TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sample</title><meta name="description" content="sample"></head><body>
<header><div data-image="logo" data-aspect="1:1"><svg></svg></div><span data-text="business_name">Sample Co</span></header>
<section class="hero"><h1 data-text="hero_title" data-max="60">Pan de verdad</h1><p data-text="hero_subtitle" data-max="120" data-optional>Hecho cada mañana</p>
<a data-goal="whatsapp" data-contact="whatsapp" href="#">Escríbenos</a><a data-goal="call" data-contact="phone" href="#">Llámanos</a>
<div class="ph" data-image="hero" data-aspect="16:9"><svg class="fallback"></svg></div></section>
<section><p data-text="about" data-max="400">Somos una panadería.</p><div data-image="side" data-aspect="1:1"><svg class="fallback"></svg></div></section>
<ul><li data-repeat="services" data-min="1" data-max="4"><h3 data-text="title" data-max="40">Pan</h3><p data-text="text" data-max="120">Rico</p></li><li data-repeat="services"><h3 data-text="title">Tortas</h3><p data-text="text">Ricas</p></li></ul>
<section data-if="hours"><p data-text="hours" data-optional>Lunes a sábado</p></section>
<p data-if="email"><a data-contact="email" data-contact-label href="#">hola@sample.com</a></p>
<p data-if="maps"><a data-contact="maps" href="#"><span data-text="address">Calle 1</span></a></p>
<a data-contact="instagram" href="#">Instagram</a>
</body></html>`;

const answers: Answers = { businessName: 'Panadería <Luna>', about: 'Panadería de masa madre en Chapinero.', contact: { whatsapp: '573001234567', address: 'Calle 60 # 9-12' }, lang: 'es', goal: 'call' };

const fill: StoredFill = {
  texts: { hero_title: 'Masa madre <script>x</script>', about: 'Pan de masa madre en Chapinero.' },
  lists: { services: [{ title: 'Pan', text: 'De masa madre' }, { title: 'Café', text: 'De Huila' }, { title: 'Galletas', text: 'De avena' }] },
  images: { hero: { alt: 'Pan en la mesa' }, side: { alt: 'El horno', scene: 'an oven' } },
  seo: { title: 'Panadería Luna en Chapinero', description: 'Pan de masa madre hecho cada mañana en Chapinero, Bogotá.' },
};

describe('parseTemplate', () => {
  it('lists the slots, lists, photos and contacts', () => {
    const m = parseTemplate(TEMPLATE);
    expect(m.errors).toEqual([]);
    expect(m.texts.map((t) => [t.name, t.max, t.optional])).toEqual([['hero_title', 60, false], ['hero_subtitle', 120, true], ['about', 400, false], ['hours', 160, true]]);
    expect(m.repeats).toEqual([{ name: 'services', min: 1, max: 4, fields: [expect.objectContaining({ name: 'title', max: 40 }), expect.objectContaining({ name: 'text', max: 120 })] }]);
    expect(m.images).toEqual([{ name: 'hero', aspect: '16:9' }, { name: 'side', aspect: '1:1' }]);
    expect(m.contacts.sort()).toEqual(['email', 'instagram', 'maps', 'phone', 'whatsapp']);
  });

  it('names what a template is missing or gets wrong', () => {
    const m = parseTemplate('<html><head></head><body><p data-text="Bad Name">x</p><div data-image="a" data-aspect="4:3"></div><a data-contact="tiktok">x</a><li data-repeat="x" data-min="5" data-max="2"><img data-image="b"></li></body></html>');
    expect(m.errors).toEqual(
      expect.arrayContaining([
        'bad data-text name "Bad Name"',
        expect.stringContaining('data-aspect must be one of'),
        expect.stringContaining('data-contact="tiktok"'),
        expect.stringContaining('data-repeat="x": data-min/data-max'),
        expect.stringContaining('holds an image slot'),
        'no data-text="hero_title"',
        'no data-contact="whatsapp" link',
      ]),
    );
  });
});

describe('fillSchema', () => {
  it('holds the words to the limits (with some slack), and required slots to be filled', () => {
    expect(fillSchema(parseTemplate(TEMPLATE)).safeParse({ ...fill, texts: { ...fill.texts, hero_title: 'x'.repeat(100) } }).success).toBe(true);
    const schema = fillSchema(parseTemplate(TEMPLATE));
    expect(schema.safeParse(fill).success).toBe(true);
    expect(schema.safeParse({ ...fill, texts: { ...fill.texts, hero_title: 'x'.repeat(101) } }).success).toBe(false);
    expect(schema.safeParse({ ...fill, texts: { about: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ...fill, lists: { services: [] } }).success).toBe(false);
  });
});

describe('fillTemplate', () => {
  const page = fillTemplate(TEMPLATE, fill, { answers, media: { photos: ['assets/photo-1.jpg'] }, photos: { hero: 'assets/photo-1.jpg' } });

  it('puts the words in, escaped, and the business name and address from the form', () => {
    expect(page).toContain('Masa madre &lt;script&gt;x&lt;/script&gt;');
    expect(page).toContain('Panadería &lt;Luna&gt;');
    expect(page).toContain('Calle 60 # 9-12');
    expect(page).not.toContain('Hecho cada mañana'); // optional and empty
    expect(page).not.toMatch(/data-(text|repeat|image|contact|if|goal|max)/);
  });

  it('makes one item per entry, dropping the samples', () => {
    expect(page.match(/<li>/g)).toHaveLength(3);
    expect(page).toContain('Galletas');
    expect(page).not.toContain('Tortas');
  });

  it('sets contact links from the contact details only, dropping what the owner has not got', () => {
    expect(page).toContain('href="tel:+573001234567"'); // the call button: the goal
    expect(page).not.toContain('Escríbenos');
    expect(page).toContain('https://www.google.com/maps/search/?api=1&amp;query=Calle%2060%20%23%209-12');
    expect(page).not.toContain('mailto:');
    expect(page).not.toContain('Instagram');
    expect(page).not.toContain('Lunes a sábado'); // data-if="hours" with no hours
  });

  it('puts a photo in its slot and keeps the drawing where there is none; no logo, no logo slot', () => {
    expect(page).toMatch(/<div class="ph"><img src="assets\/photo-1.jpg" alt="Pan en la mesa"/);
    expect(page).toMatch(/<svg class="fallback"\s*\/?>/);
    expect(page).not.toMatch(/<svg\s*\/?>/);
  });

  it('writes the head: language, title, description, and the business data', () => {
    expect(page).toContain('<html lang="es">');
    expect(page).toContain('<title>Panadería Luna en Chapinero</title>');
    expect(page).not.toContain('<title>Sample</title>');
    expect(page).toContain('"@type":"LocalBusiness"');
    expect(page).toContain('"telephone":"+573001234567"');
  });

  it('passes the page checks', () => {
    const checked = checkPage(page, { contact: answers.contact, businessName: answers.businessName, lang: 'es', homeUrl: 'https://app.test/', reportUrl: 'https://app.test/r', privacyUrl: 'https://app.test/p', assets: ['assets/photo-1.jpg'] });
    expect(checked.violations).toEqual([]);
    expect(checked.repairs).toEqual([]);
  });

  it('keeps the first main button when the goal has none', () => {
    const info = fillTemplate(TEMPLATE, fill, { answers: { ...answers, goal: 'info' }, media: { photos: [] }, photos: {} });
    expect(info).toContain('Escríbenos');
    expect(info).not.toContain('Llámanos');
  });
});

it('displayPhone groups the number after its country code', () => {
  expect(displayPhone('573001234567')).toBe('+57 300 123 4567');
});

describe('template mode in the generate job', () => {
  const library = (ids: string[]) => ({ list: async () => ids.map((id) => ({ id, description: `${id} look` })), get: async (id: string) => (ids.includes(id) ? TEMPLATE : undefined) });
  const words: StoredFill = { ...fill, texts: { hero_title: 'Masa madre', about: 'Pan de masa madre en Chapinero.' } };

  async function made(ids = ['warm', 'bold']) {
    const t = harness({ pick: 'bold', fill: words });
    t.generateDeps.pageMode = 'template';
    t.generateDeps.templates = library(ids);
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    return t;
  }

  it('picks a template, fills it with the cheap model, and keeps the words with the draft; Opus is never called', async () => {
    const t = await made();
    expect(t.jobs.get('job-1')!.status).toBe('DONE');
    expect(t.calls).toEqual(['classify', 'plan_site', 'pick_template', 'fill_page']);
    expect(t.writer.requests).toEqual([]);
    const doc = JSON.parse(t.objects.get('_src/panaderia-luna/draft1.json')!);
    expect(doc.template).toMatchObject({ id: 'bold', fill: { texts: { hero_title: 'Masa madre' } } });
    expect(t.objects.get('_draft/draft1/index.html')).toContain('<h1>Masa madre</h1>');
    expect(t.jobs.get('job-1')!.usage.map((u) => u.step)).toEqual(['classify', 'plan_site', 'pick_template', 'fill_page']);
  });

  it('skips the pick with one template', async () => {
    const t = await made(['warm']);
    expect(t.calls).toEqual(['classify', 'plan_site', 'fill_page']);
  });

  it('a redesign fills the template again with the current words and the request', async () => {
    const t = await made();
    await editSite(t.sites.get('panaderia-luna')!, { instruction: 'más corto el título' }, t.ownerDeps);
    t.options.fill = { ...words, texts: { ...words.texts, hero_title: 'Pan' } };
    await runGenerateJob('job-2', t.generateDeps);
    expect(t.jobs.get('job-2')!.status).toBe('DONE');
    const fillRequest = t.requests.at(-1)!;
    expect(fillRequest.user).toContain('"hero_title":"Masa madre"');
    expect(fillRequest.guarded).toContain('más corto el título');
    expect(t.objects.get('_draft/draft2/index.html')).toContain('<h1>Pan</h1>');
  });

  it('the admin notice names the template and prices the pick, the fill and the photos', async () => {
    const t = harness({ pick: 'bold', fill: words });
    const notices: string[] = [];
    const haiku = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const callTool = (async (request) => ({ ...(await t.callTool(request)), usage: { step: request.tool.name, modelId: haiku, inputTokens: 5000, outputTokens: 2000 } })) as typeof t.callTool;
    await submit({ ...body, aiImages: true }, '1.2.3.4', t.submitDeps);
    t.options.fill = { ...words, images: { ...words.images, hero: { alt: 'Pan', scene: 'bread on a table' } } };
    await runGenerateJob('job-1', {
      ...t.generateDeps,
      callTool,
      modelId: haiku,
      pageMode: 'template',
      templates: library(['warm', 'bold']),
      generateImage: async () => new Uint8Array([1]),
      imageModelId: 'stability.stable-image-core-v1:1',
      announce: async (_: string, message: string) => void notices.push(message),
    });
    const message = notices[0]!;
    expect(message).toContain(`  plantilla (${haiku}): $0.02`); // 5k × $1.1 + 2k × $5.5 per million = $0.0165
    expect(message).toContain(`  página (${haiku}): $0.02`);
    expect(message).toContain('  fotos (2 × stability.stable-image-core-v1:1): $0.08'); // the hero and the side photo
    expect(message).toMatch(/^Costo: \$0\.13 \+ desconocido$/m); // questions, pick and fill on Haiku, 2 photos; the fake pre-screen has no price
    expect(message).toContain(`Plantilla: bold, llenada por ${haiku} · fotos IA on (dueño: on)`);
    expect(message).not.toContain('opus');
  });

  it('fails the job when there are no templates', async () => {
    const t = await made([]);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'FAILED' });
    expect(t.sites.size).toBe(0);
  });
});

it('toolInputOf merges a tool answer Haiku split into several calls', () => {
  expect(toolInputOf([{ texts: {} }, { lists: {} }, { seo: {} }])).toEqual({ texts: {}, lists: {}, seo: {} });
  expect(toolInputOf([{ a: 1 }])).toEqual({ a: 1 });
  expect(toolInputOf([])).toBeUndefined();
});
