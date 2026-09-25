import { Parser } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import type { SiteDoc } from '../src/core/drafts';
import { fillPage } from '../src/core/fill';
import { sanitizePage } from '../src/core/sanitize';
import { MODEL_PAGE } from './fixtures';
import { urls } from './harness';

const source = sanitizePage(MODEL_PAGE).html;
const doc = (contact: Partial<SiteDoc['answers']['contact']> = {}, media: SiteDoc['media'] = { photos: [] }): SiteDoc => ({
  answers: { businessName: 'Panadería Luna', about: 'Pan de masa madre.', lang: 'es', contact: { whatsapp: '573001234567', ...contact } },
  notes: [],
  media,
});
const fill = (d: SiteDoc, page = source) => fillPage(page, d, 'panaderia-luna', urls);

describe('fillPage', () => {
  it('is deterministic and leaves no placeholder behind', () => {
    const d = doc({ address: 'Calle 60 # 9-12', phone: '576015551234', email: 'hola@luna.test', instagram: 'panaderia.luna' }, { logo: 'assets/logo.png', photos: [], hero: 'assets/hero.jpg' });
    const page = fill(d);
    expect(fill(d)).toBe(page);
    expect(page).not.toContain('{{');
    expect(page).toContain('href="https://wa.me/573001234567?text=Hola%2C%20vi%20su%20sitio');
    expect(page).toContain('href="tel:+576015551234">+576015551234</a>');
    expect(page).toContain('href="mailto:hola@luna.test"');
    expect(page).toContain('href="https://maps.google.com/?q=Calle%2060%20%23%209-12"');
    expect(page).toContain('href="https://instagram.com/panaderia.luna"');
    expect(page).toContain('src="assets/logo.png"');
    expect(page).toContain('url("assets/hero.jpg")');
    expect(page).toContain('<address>Calle 60 # 9-12</address>');
    expect(page).toContain('<iframe title="Mapa: Panadería Luna, Calle 60 # 9-12" loading="lazy"');
  });

  it('removes the element that carries a placeholder with no value, and data-needs groups', () => {
    const page = fill(doc());
    for (const gone of ['tel:', 'mailto:', 'instagram.com', 'maps.google.com', '<address>', 'Teléfono:', 'data-slot', '<img', '<iframe']) expect(page).not.toContain(gone);
    expect(page).toContain('background:none center/cover'); // no hero: the CSS image goes
    expect(page).toContain('Escríbenos por WhatsApp');
    expect(page).not.toContain('data-needs');
  });

  it('uses the first photo as the hero when there is one', () => {
    expect(fill(doc({}, { photos: ['assets/photo-1.jpg'] }))).toContain('url("assets/photo-1.jpg")');
  });

  it('escapes every value the owner typed', () => {
    const evil = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
    const page = fill({ ...doc({ address: evil }), answers: { ...doc().answers, businessName: evil, contact: { whatsapp: '573001234567', address: evil } } });
    const elements: string[] = [];
    const attributes: string[] = [];
    new Parser({ onopentag: (name, attrs) => (elements.push(name), attributes.push(...Object.keys(attrs))) }).end(page);
    expect(elements).not.toContain('script');
    expect(elements.filter((e) => e === 'img')).toEqual([]);
    expect(attributes).not.toContain('onerror');
    expect(page).toContain('<address>"&gt;&lt;script&gt;');
    expect(page).toContain(encodeURIComponent(evil));
  });

  it('adds the platform footer in the page language and sets the html lang', () => {
    const es = fill(doc());
    expect(es).toContain('<html lang="es">');
    expect(es).toMatch(/Sitio creado con Coyote<a href="https:\/\/app\.test\/reportar\?sitio=panaderia-luna"[^>]*>Reportar<\/a><a href="https:\/\/app\.test\/privacidad"[^>]*>Privacidad<\/a><\/footer>\s*<\/body>/);
    const pt = fillPage(source, { ...doc(), answers: { ...doc().answers, lang: 'pt' } }, 'lua', urls);
    expect(pt).toContain('<html lang="pt-BR">');
    expect(pt).toContain('Site criado com Coyote');
    expect(pt).toContain('Ol%C3%A1');
  });
});
