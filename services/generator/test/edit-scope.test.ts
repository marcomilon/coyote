import { describe, expect, it } from 'vitest';
import { editScope } from '../src/core/edit-scope';

const page = `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces&family=Inter"><style>:root{--brand:#c2410c;--ink:rgb(20, 20, 20);--display:"Fraunces", serif;--gap:2rem}body{color:var(--ink)}</style><script>console.log(1)</script></head>
<body><main><h1 class="title">Panadería Luna</h1><section class="menu"><h2>Menú</h2><ul><li class="item">Pan</li><li class="item">Café</li></ul></section>
<section class="about" style="padding:1rem"><h2>Nosotros</h2><p>Desde 1990.</p></section></main></body></html>`;

describe('edit scope', () => {
  it('an update: new words, an item or a section copied, a section moved, new colors and fonts in :root', () => {
    expect(editScope(page, page.replace('<li class="item">Café</li>', '<li class="item">Café</li><li class="item">Croissants</li>'))).toEqual([]);
    const about = '<section class="about" style="padding:1rem"><h2>Nosotros</h2><p>Desde 1990.</p></section>';
    expect(editScope(page, page.replace(about, '').replace('<section class="menu">', `${about}<section class="menu">`))).toEqual([]);
    expect(editScope(page, page.replace('--brand:#c2410c', '--brand:#15803d').replace('rgb(20, 20, 20)', 'oklch(0.2 0 0)'))).toEqual([]);
    expect(editScope(page, page.replace('"Fraunces", serif', 'Inter, sans-serif'))).toEqual([]);
  });

  it('design work: new classes, tags, inline styles, scripts, fonts, or styles beyond the :root tokens', () => {
    expect(editScope(page, page.replace('class="title"', 'class="title hero-xl"'))).toEqual(['new classes: hero-xl']);
    expect(editScope(page, page.replace('<p>Desde 1990.</p>', '<p>Desde 1990.</p><blockquote>¡Rico!</blockquote>'))).toEqual(['new tags: blockquote']);
    expect(editScope(page, page.replace('<h1 class="title">', '<h1 class="title" style="color:green">'))).toEqual(['new inline styles: color:green']);
    expect(editScope(page, page.replace('</main>', '<script>alert(1)</script></main>'))).toContain('scripts changed');
    expect(editScope(page, page.replace('body{color:var(--ink)}', 'body{color:green}'))).toEqual(['styles changed beyond the :root colors and fonts']);
    expect(editScope(page, page.replace('--gap:2rem', '--gap:2rem;--new:#fff'))).toEqual(['styles changed beyond the :root colors and fonts']);
    expect(editScope(page, page.replace('--brand:#c2410c', '--brand:green'))).toEqual(['--brand: "green" is not a color']);
    expect(editScope(page, page.replace('"Fraunces", serif', '"Lobster", cursive'))).toEqual(['--display: ""Lobster", cursive" is not a font the page loads']);
    expect(editScope(page, page.replace('--gap:2rem', '--gap:4rem'))).toEqual(['--gap: only colors and fonts may change']);
  });
});
