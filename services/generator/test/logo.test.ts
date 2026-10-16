import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasLogoSpot, placeLogo, tagLogo } from '../src/core/logo';

const example = (slug: string) => readFileSync(new URL(`../../../examples/sites/${slug}/index.html`, import.meta.url), 'utf8');
const brandOf = (page: string) => /<a data-logo[\s>][\s\S]*?<\/a>/.exec(page)?.[0] ?? '';

describe('logo spot', () => {
  it.each([
    ['panaderia-rosa', 'Panadería Rosa', undefined],
    ['residencial-oliva', 'Residencial Oliva', '<svg data-logo-mark'],
    ['salon-luna', 'Salón Luna', '<svg data-logo-mark'],
    ['taller-ruiz', 'Taller Ruiz', '<span data-logo-mark class="brand-mark"'],
  ])('tags the brand of %s, and its drawn mark', (slug, name, mark) => {
    const page = example(slug);
    const tagged = tagLogo(page, name);
    expect(hasLogoSpot(tagged)).toBe(true);
    expect(tagged.replace(/ data-logo(-mark)?/g, '')).toBe(page); // only the two attributes, nothing else changes
    if (mark) expect(brandOf(tagged)).toContain(mark);
    else expect(brandOf(tagged)).not.toContain('data-logo-mark');
    expect(tagLogo(tagged, name)).toBe(tagged); // once
  });

  it('puts the logo in place of the drawn mark, or before a text-only name', () => {
    const svg = tagLogo('<html><body><header><a href="#inicio" class="brand" aria-label="Oliva"><svg viewBox="0 0 4 4"><path d="M0 0"/></svg><span>Oliva</span></a></header></body></html>', 'Oliva');
    const placed = placeLogo(svg, 'assets/logo-ab12.png', 'Oliva')!;
    expect(placed).not.toContain('<svg');
    expect(brandOf(placed)).toMatch(/^<a data-logo href="#inicio" class="brand" aria-label="Oliva"><img src="assets\/logo-ab12\.png" alt="" data-logo-mark style="[^"]+"><span>Oliva<\/span><\/a>$/);
    // A second logo replaces the first.
    expect(placeLogo(placed, 'assets/logo-cd34.png', 'Oliva')).toContain('assets/logo-cd34.png');
    expect(placeLogo(placed, 'assets/logo-cd34.png', 'Oliva')).not.toContain('logo-ab12');

    const text = tagLogo('<html><body><header><nav><a href="#top">Panadería <b>Rosa</b></a></nav></header></body></html>', 'Panadería Rosa');
    expect(brandOf(placeLogo(text, 'assets/logo-x.png', 'Panadería Rosa')!)).toMatch(/^<a data-logo href="#top"><img src="assets\/logo-x\.png" alt="" data-logo-mark style="[^"]*margin-inline-end[^"]*">Panadería <b>Rosa<\/b><\/a>$/);
  });

  it('finds no spot without a header brand: the page writer places the logo then', () => {
    const page = '<html><body><header><a href="https://wa.me/51987654321">Escríbenos</a></header><h1>Oliva</h1></body></html>';
    expect(tagLogo(page, 'Oliva')).toBe(page);
    expect(placeLogo(page, 'assets/logo-x.png', 'Oliva')).toBeUndefined();
  });
});
