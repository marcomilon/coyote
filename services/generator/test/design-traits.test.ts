import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { designTraits } from '../src/core/design-traits';

const example = (slug: string) => readFileSync(new URL(`../../../examples/sites/${slug}/index.html`, import.meta.url), 'utf8');

describe('designTraits', () => {
  it('reads the fonts, the main colors and the background of a page', () => {
    expect(designTraits(example('salon-luna'))).toEqual({ fonts: ['Gloock', 'Jost'], colors: ['#1d2742', '#b8893b', '#fbf8f2', '#3b4560'], dark: false });
    expect(designTraits(example('residencial-oliva'))).toMatchObject({ fonts: ['Marcellus', 'Jost'], dark: true });
  });

  it('resolves custom properties and short colors, and leaves out generic fonts, white, black and see-through colors', () => {
    const page = `<style>:root{--bg:#123;--accent:rgb(200, 50, 10)}
      html{color:#fff}body{background:var(--bg);font-family:'Space Grotesk',system-ui,sans-serif;color:#000}
      h1{color:var(--accent);border-color:rgba(0,0,0,.2)}a{color:var(--accent)}</style>`;
    expect(designTraits(page)).toEqual({ fonts: ['Space Grotesk'], colors: ['#c8320a', '#112233'], dark: true });
  });

  it('says nothing about the background when the page sets none', () => {
    expect(designTraits('<p>hola</p>')).toEqual({ fonts: [], colors: [] });
  });
});
