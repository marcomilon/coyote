import { describe, expect, it } from 'vitest';
import { applyChanges, elide } from '../src/core/page-outline';

const page = `<!doctype html><html><head><style>body{color:red}</style><script>console.log(1)</script></head>
<body class="min-h-screen bg-stone-50 text-stone-900 antialiased selection:bg-amber-200 font-sans leading-relaxed">
<h1 class="text-4xl">Panadería Luna</h1><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>
<img src="data:image/png;base64,AAAA" alt="Pan"><ul><li>Pan de masa madre</li><li>Café</li></ul></body></html>`;

describe('page outline', () => {
  it('hides styles, scripts, drawings, data URIs, and long attributes, and puts them back', () => {
    const outline = elide(page);
    expect(outline.text).not.toContain('color:red');
    expect(outline.text).not.toContain('console.log');
    expect(outline.text).not.toContain('<path');
    expect(outline.text).not.toContain('base64');
    expect(outline.text).not.toContain('selection:bg-amber-200');
    expect(outline.text).toContain('class="text-4xl"'); // short attributes stay
    expect(outline.text).toContain('<h1 class="text-4xl">Panadería Luna</h1>');
    expect(outline.restore(outline.text)).toBe(page);
  });

  it('keeps a drawing with words in it, minus its geometry', () => {
    const dial = `<html><body><svg viewBox="0 0 10 10"><title>Abrimos de 7:00 a 19:00</title><path d="${'M0 0 L10 10 '.repeat(10)}"/></svg></body></html>`;
    const outline = elide(dial);
    expect(outline.text).toContain('<title>Abrimos de 7:00 a 19:00</title>');
    expect(outline.text).not.toContain('L10 10');
    expect(outline.restore(outline.text)).toBe(dial);
  });

  it('applies changes that match once, and edits survive the restore', () => {
    const outline = elide(page);
    const changed = applyChanges(outline.text, [
      { find: '<li>Café</li>', replace: '<li>Café</li><li>Croissants</li>' },
      { find: 'Panadería Luna</h1>', replace: 'Panadería Luna Nueva</h1>' },
    ]);
    expect('text' in changed).toBe(true);
    const restored = outline.restore((changed as { text: string }).text);
    expect(restored).toContain('<li>Croissants</li>');
    expect(restored).toContain('Panadería Luna Nueva');
    expect(restored).toContain('body{color:red}');
  });

  it('refuses a find that is missing or ambiguous, and anything in the brackets that is not a placeholder of the page', () => {
    const { text } = elide(page);
    const problems = (changes: Parameters<typeof applyChanges>[1]) => (applyChanges(text, changes) as { problems?: string[] }).problems ?? [];
    expect(problems([{ find: 'Croissants', replace: 'x' }])[0]).toContain('not found');
    expect(problems([{ find: '<li>', replace: '<li>x' }])[0]).toContain('found 2 times');
    expect(problems([{ find: '<li>Café</li>', replace: '<li>Café ⟦2b⟧</li>' }])[0]).toContain('⟦2b⟧');
    expect(problems([{ find: '<li>Café</li>', replace: '<li>Café ⟦99⟧</li>' }])[0]).toContain('⟦99⟧');
    expect(problems([{ find: '<li>Café</li>', replace: '<li>Café ⟧</li>' }])).toHaveLength(1);
    // Copying a hidden part (an item's icon) for a new item is fine.
    expect(problems([{ find: '<li>Café</li>', replace: '<li>Café</li><li>⟦2⟧ Té</li>' }])).toEqual([]);
    // Moving or dropping a hidden part is fine.
    expect(problems([{ find: '</h1>⟦2⟧', replace: '</h1>' }])).toEqual([]); // the drawing
    expect(problems([{ find: '</h1>⟦2⟧', replace: '⟦2⟧</h1>' }])).toEqual([]);
  });
});
