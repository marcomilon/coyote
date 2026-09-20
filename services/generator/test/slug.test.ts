import { describe, expect, it } from 'vitest';
import { rejectSlug, slugify, withSuffix } from '../src/core/slug';

describe('slugify', () => {
  it.each([
    ['Panadería Luna', 'panaderia-luna'],
    ['  Açaí & Cia.  ', 'acai-cia'],
    ['Peluquería "El Ñato" #2', 'peluqueria-el-nato-2'],
    ['🔥🔥🔥', 'sitio'],
  ])('%s → %s', (name, slug) => expect(slugify(name)).toBe(slug));

  it('caps the length and never ends with a dash', () => {
    const slug = slugify('a'.repeat(39) + ' ' + 'b'.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('rejectSlug', () => {
  it.each(['www', 'api', 'app', 'preview', 'admin', '_preview'])('reserved: %s', (slug) =>
    expect(rejectSlug(slug)).toBe('reserved'),
  );

  it.each(['bancolombia', 'bancolombia-soporte', 'mi-nubank', 'sat-citas', 'banco-azteca', 'mercado-pago-ayuda'])(
    'brand: %s',
    (slug) => expect(rejectSlug(slug)).toBe('brand'),
  );

  it.each(['panaderia-luna', 'satelite-tv', 'pixel-estudio', 'upstairs-cafe', 'visaje-barberia'])(
    'allowed: %s',
    (slug) => expect(rejectSlug(slug)).toBeNull(),
  );
});

describe('withSuffix', () => {
  it('adds 4 unambiguous characters', () => {
    expect(withSuffix('panaderia-luna')).toMatch(/^panaderia-luna-[a-hj-km-np-z2-9]{4}$/);
  });
});
