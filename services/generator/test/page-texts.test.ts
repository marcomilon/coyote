import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contact } from '../src/core/content';
import { contactChanges, editTexts, ownerTextsAfter, pageTexts, restoreTexts } from '../src/core/page-texts';

const contact: Contact = { whatsapp: '51987654321', address: 'Av. Bolívar 244, Pueblo Libre' };
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Panadería Luna &amp; Café</title>
<meta name="description" content='Pan de masa madre en "Lima"'><style>h1{color:red}</style><script>document.title = 'x'</script></head>
<body><header><nav><a href="#menu">Menú</a> · <a href="#">→</a></nav></header>
<h1 class="big">Pan <em>recién</em> horneado</h1>
<p>
  Horneamos cada día &lt;desde las 6&gt;.
</p>
<svg viewBox="0 0 10 10"><title>Un pan</title><text x="1" y="5">Desde 1998</text></svg>
<h2>Visítanos</h2><p>Av. Bolívar 244,<br>Pueblo Libre</p><a href="https://wa.me/51987654321">WhatsApp 987 654 321</a>
<template><p>Oculto</p></template><noscript>Activa JavaScript</noscript></body></html>`;

describe('page texts', () => {
  it('lists each block a visitor reads, in order, grouped under the headings, with the title and description', () => {
    expect(pageTexts(page, contact)).toEqual([
      { id: 0, text: 'Panadería Luna & Café', kind: 'title' },
      { id: 1, text: 'Pan de masa madre en "Lima"', kind: 'description' },
      { id: 2, text: 'Menú', role: 'menu' },
      { id: 3, text: 'Pan recién horneado', group: 'Pan recién horneado', role: 'headline' },
      { id: 4, text: 'Horneamos cada día <desde las 6>.', group: 'Pan recién horneado', role: 'paragraph' },
      { id: 5, text: 'Desde 1998', group: 'Pan recién horneado', role: 'text' },
      { id: 6, text: 'Visítanos', group: 'Visítanos', role: 'heading' },
      { id: 7, text: 'Av. Bolívar 244, Pueblo Libre', group: 'Visítanos', role: 'paragraph', showsContact: true },
      { id: 8, text: 'WhatsApp 987 654 321', group: 'Visítanos', role: 'button', showsContact: true },
    ]);
  });

  it('replaces only the edited texts, escaped, keeping the markup around them', () => {
    const result = editTexts(
      page,
      [
        { id: 0, from: 'Panadería Luna & Café', to: 'Luna <Pan>' },
        { id: 1, from: 'Pan de masa madre en "Lima"', to: "Pan 'de verdad'" },
        { id: 4, from: 'Horneamos cada día <desde las 6>.', to: '  Abrimos a las 7.  ' },
        { id: 2, from: 'Menú', to: 'Menú' }, // unchanged
      ],
      contact,
    );
    expect(result).toEqual({
      page: page
        .replace('Panadería Luna &amp; Café', 'Luna &lt;Pan&gt;')
        .replace(`content='Pan de masa madre en "Lima"'`, 'content="Pan &#39;de verdad&#39;"')
        .replace('\n  Horneamos cada día &lt;desde las 6&gt;.\n', 'Abrimos a las 7.'),
    });
  });

  it('keeps the formatting of the words the owner kept', () => {
    const edit = (html: string, to: string) => {
      const doc = `<html><body>${html}</body></html>`;
      const result = editTexts(doc, [{ id: 0, from: pageTexts(doc, contact)[0]!.text, to }], contact);
      return 'page' in result ? result.page.slice(12, -14) : result.problem;
    };
    // A word changed inside formatting stays formatted; one outside stays plain.
    expect(edit('<h1>Pan <em class="rosa">recién</em> horneado</h1>', 'Pan siempre horneado')).toBe('<h1>Pan <em class="rosa">siempre</em> horneado</h1>');
    expect(edit('<h1>Pan <em>recién</em> horneado</h1>', 'Pan recién hecho')).toBe('<h1>Pan <em>recién</em> hecho</h1>');
    // Words added at a boundary go to the plainer side, also at the end of the block.
    expect(edit('<h1>Pan de <em>barrio</em></h1>', 'Pan de barrio en Lima')).toBe('<h1>Pan de <em>barrio</em> en Lima</h1>');
    expect(edit('<h1><strong>Pan</strong> de barrio</h1>', 'Rico Pan de barrio')).toBe('<h1>Rico <strong>Pan</strong> de barrio</h1>');
    // Line breaks and layout stay; a rewrite goes where the old text began.
    expect(edit('<p>Av. Lima 1,<br>Miraflores</p>', 'Av. Lima 2, Miraflores')).toBe('<p>Av. Lima 2,<br>Miraflores</p>');
    expect(edit('<p>Av. Lima 1,<br/>Miraflores</p>', 'Av. Lima 1, San Isidro')).toBe('<p>Av. Lima 1,<br/>San Isidro</p>');
    expect(edit('<p>Av. Lima 1,<br>Miraflores</p>', 'Av. Lima 1,Miraflores')).toBe('<p>Av. Lima 1,Miraflores</p>');
    expect(edit('<h1><span class="block">Panadería</span> <span class="block">Luna</span></h1>', 'Panadería Sol')).toBe('<h1><span class="block">Panadería</span> <span class="block">Sol</span></h1>');
    expect(edit('<p><b>Hola</b> mundo</p>', 'Adiós')).toBe('<p><b>Adiós</b></p>');
    // Sibling elements laid out apart read with a space between them; new words there go into the next one.
    expect(pageTexts('<html><body><h1><span class="block">Panadería</span><span>Rosa</span></h1></body></html>', contact)[0]!.text).toBe('Panadería Rosa');
    expect(edit('<h1><span class="block">Panadería</span><span>Rosa</span></h1>', 'Panadería Doña Rosa')).toBe('<h1><span class="block">Panadería</span><span>Doña Rosa</span></h1>');
    expect(pageTexts('<html><body><h1>Hola<strong>!</strong></h1></body></html>', contact)[0]!.text).toBe('Hola!');
  });

  it('says what each text is on the page', () => {
    const doc = `<html><body><nav><ul><li><a href="#">Inicio</a></li></ul></nav><header><a class="px-6 py-3" href="#">Pide ya</a></header>
<h3>Pan</h3><ul><li>Pandebono</li></ul><blockquote>Lo mejor</blockquote><div><a href="#">Ver más</a></div>
<footer><p>Hecho en Lima</p><a href="#">Arriba</a></footer></body></html>`;
    expect(pageTexts(doc, contact).map((t) => [t.text, t.role])).toEqual([
      ['Inicio', 'menu'],
      ['Pide ya', 'button'],
      ['Pan', 'subheading'],
      ['Pandebono', 'item'],
      ['Lo mejor', 'quote'],
      ['Ver más', 'button'],
      ['Hecho en Lima', 'footer'],
      ['Arriba', 'footer'],
    ]);
  });

  it('puts the texts of one card together, and leaves a section and a list of cards alone', () => {
    const card = (n: number) => `<article><span class="num">${n}</span><h3>Punto ${n}</h3><p>Texto ${n}</p></article>`;
    const doc = `<html><body><section><h2>Por qué elegirnos</h2><div class="grid">${card(1)}${card(2)}</div><p>Sin tarjeta</p></section>
<dl><div><dt>Horario</dt><dd>9 a 18</dd></div><div><dt>Pago</dt><dd>Efectivo</dd></div></dl></body></html>`;
    expect(pageTexts(doc, contact).map((t) => [t.text, t.card])).toEqual([
      ['Por qué elegirnos', undefined],
      ['1', 0],
      ['Punto 1', 0],
      ['Texto 1', 0],
      ['2', 1],
      ['Punto 2', 1],
      ['Texto 2', 1],
      ['Sin tarjeta', undefined],
      ['Horario', 2],
      ['9 a 18', 2],
      ['Pago', 3],
      ['Efectivo', 3],
    ]);
  });

  it('keeps buttons in a row apart, and a layout element with its own words together', () => {
    const doc = `<html><body><div class="flex"><a href="#">Cómo llegar</a> · <a href="#">Escríbenos</a></div><div>Lunes a viernes <span class="chip">7 a 19</span></div></body></html>`;
    expect(pageTexts(doc, contact).map((t) => t.text)).toEqual(['Cómo llegar', 'Escríbenos', 'Lunes a viernes 7 a 19']);
  });

  it('refuses a list read from another version of the page', () => {
    expect(editTexts(page, [{ id: 3, from: 'Pastel', to: 'Torta' }], contact)).toEqual({ problem: 'stale' });
    expect(editTexts(page, [{ id: 99, from: 'Pan', to: 'Torta' }], contact)).toEqual({ problem: 'stale' });
    expect(editTexts(page, [{ id: 8, from: 'WhatsApp 987 654 321', to: 'WhatsApp 987 654 321' }], contact)).toEqual({ page });
  });

  it('finds the contact details an edit changes, in the form the page wrote them', () => {
    const edit = (from: string, to: string) => contactChanges([{ id: 0, from, to }], contact);
    // Written without the country code: the new number keeps the old one's.
    expect(edit('WhatsApp 987 654 321', 'WhatsApp 912 345 678')).toEqual({ whatsapp: '51912345678' });
    expect(edit('WhatsApp 987 654 321', 'Escríbenos al +51 912 345 678')).toEqual({ whatsapp: '51912345678' });
    expect(edit('Av. Bolívar 244, Pueblo Libre', 'Jr. Unión 120, Lima')).toEqual({ address: 'Jr. Unión 120, Lima' });
    expect(contactChanges([{ id: 0, from: 'Correo: hola@luna.pe', to: 'Correo: pedidos@luna.pe' }], { ...contact, email: 'hola@luna.pe' })).toEqual({ email: 'pedidos@luna.pe' });
    // Other words, or the detail taken out: the contact stays.
    expect(edit('WhatsApp 987 654 321', 'Escríbenos: 987 654 321')).toEqual({});
    expect(edit('WhatsApp 987 654 321', 'WhatsApp')).toEqual({});
  });

  it('remembers the texts the owner wrote while they are on the page', () => {
    const v1 = '<html><body><h1>Pan de barrio</h1><p>Abrimos a las 6.</p></body></html>';
    const v2 = v1.replace('Abrimos a las 6.', 'Abrimos a las 7.');
    const v3 = v2.replace('Pan de barrio', 'Pan casero');
    expect(ownerTextsAfter(v1, v2, contact)).toEqual(['Abrimos a las 7.']);
    expect(ownerTextsAfter(v2, v3, contact, ['Abrimos a las 7.'])).toEqual(['Abrimos a las 7.', 'Pan casero']);
    expect(ownerTextsAfter(v3, v1, contact, ['Abrimos a las 7.', 'Pan casero'])).toEqual(['Pan de barrio', 'Abrimos a las 6.']);
  });

  it('puts back the owner\'s texts a redesign reworded, unless the request asked for it', () => {
    const before = '<html><body><h1>Pan de masa madre en Chapinero</h1><p>Horneamos cada mañana desde las 5 con harina de la región.</p><p>Envíos gratis</p></body></html>';
    const after = '<html><body><section><h1 class="big">Pan de masa madre, en Chapinero</h1><p>Cada mañana horneamos desde las 5 con harina de la región.</p><p>Visítanos hoy</p></section></body></html>';
    const keep = ['Pan de masa madre en Chapinero', 'Horneamos cada mañana desde las 5 con harina de la región.', 'Envíos gratis'];
    const result = restoreTexts(before, after, keep, 'hazla más moderna', contact);
    expect(result.page).toContain('<h1 class="big">Pan de masa madre en Chapinero</h1>');
    expect(result.page).toContain('<p>Horneamos cada mañana desde las 5 con harina de la región.</p>');
    expect(result).toMatchObject({ kept: keep.slice(0, 2), restored: keep.slice(0, 2), lost: ['Envíos gratis'] });
    // The request names the heading: the redesign's version stays.
    const asked = restoreTexts(before, after, keep, 'cambia el título a algo sobre Chapinero', contact);
    expect(asked.page).toContain('Pan de masa madre, en Chapinero');
    expect(asked.restored).toEqual([keep[1]]);
    // Unchanged texts are simply kept.
    expect(restoreTexts(before, before, keep, '', contact)).toEqual({ page: before, kept: keep, restored: [], lost: [] });
  });

  // Pages Opus wrote: every text can be changed on its own, and nothing else moves.
  const sites = join(__dirname, '../../../examples/sites');
  for (const slug of readdirSync(sites)) {
    it(`edits each text of ${slug} alone`, () => {
      const written = readFileSync(join(sites, slug, 'index.html'), 'utf8');
      const texts = pageTexts(written, contact);
      expect(texts.length).toBeGreaterThan(20);
      expect(texts.every((t) => t.kind || t.role)).toBe(true);
      expect(texts.filter((t) => t.role === 'headline')).toHaveLength(1);
      for (const { id, text, showsContact } of texts) {
        if (showsContact) continue;
        const edited = editTexts(written, [{ id, from: text, to: `Nuevo ${id}` }], contact);
        if (!('page' in edited)) throw new Error(`${slug} #${id}: ${JSON.stringify(edited)}`);
        const after = pageTexts(edited.page, contact).map((t) => t.text);
        expect(after).toEqual(texts.map((t) => (t.id === id ? `Nuevo ${id}` : t.text)));
      }
    });
  }
});
