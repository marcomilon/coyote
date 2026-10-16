/**
 * What a page looks like, read from its HTML: its fonts, its main colors, and whether its background is dark. A new
 * design tells the page writer these, so it makes a page that looks different (page-writer.ts `avoid`).
 */
export interface DesignTraits {
  fonts: string[];
  colors: string[];
  /** Unset: the page's background color wasn't found. */
  dark?: boolean;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', 'emoji', 'math', 'fangsong']);
const COLOR = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/gi;

/** A color as #rrggbb, or undefined for a see-through rgba. */
function hex(color: string): string | undefined {
  const c = color.toLowerCase();
  if (c.startsWith('#')) return c.length === 4 ? `#${[...c.slice(1)].map((d) => d + d).join('')}` : c;
  const [r, g, b, a] = c.match(/[\d.]+/g)!.map(Number);
  if (a !== undefined && a < 1) return undefined;
  return `#${[r, g, b].map((n) => Math.min(255, n!).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function designTraits(html: string): DesignTraits {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  // Custom properties, so var(--x) counts as the color or font it holds.
  const vars = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => [m[1]!, m[2]!.trim()]));
  const resolve = (value: string, depth = 0): string =>
    depth > 4 ? value : value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (all, name: string) => (vars.has(name) ? resolve(vars.get(name)!, depth + 1) : all));
  const body = css.replace(/(--[\w-]+)\s*:[^;}]+/g, '');

  const fonts = [
    ...[...html.matchAll(/fonts\.googleapis\.com\/css2?\?[^"'\s)]*/g)].flatMap((m) => [...m[0].matchAll(/family=([^:&;]+)/g)].map((f) => decodeURIComponent(f[1]!.replace(/\+/g, ' ')))),
    ...[...body.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/gi)].flatMap((m) =>
      resolve(m[1]!)
        .split(',')
        .map((f) => f.replace(/^[^"']*?\d[\w./]*\s+(?=["'])/, '').replace(/["']/g, '').trim())
        .filter((f) => f && !GENERIC.has(f.toLowerCase()) && !/\d|var\(/.test(f))
        .slice(0, 1),
    ),
  ];

  const counts = new Map<string, number>();
  for (const m of resolve(body).matchAll(COLOR)) {
    const c = hex(m[0]);
    if (c && c !== '#ffffff' && c !== '#000000') counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);

  const background = [...body.matchAll(/(?<=^|[}\/])\s*(?:html|body|:root)[^{]*\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1]!.matchAll(/background(?:-color)?\s*:\s*([^;]+)/gi)].map((d) => resolve(d[1]!)))
    .map((value) => value.match(COLOR)?.map(hex).find(Boolean))
    .find(Boolean);

  return { fonts: [...new Set(fonts)].slice(0, 4), colors, ...(background && { dark: luminance(background) < 0.35 }) };
}
