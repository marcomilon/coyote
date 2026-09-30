/**
 * The page as the chat model sees it: styles, scripts, drawings without words, embedded images, and long
 * class, style, and geometry attributes become placeholders (⟦n⟧), so what is left is the markup and the text a visitor reads, at a
 * fraction of the tokens. The model answers with find/replace changes on that outline; `restore` puts the
 * hidden parts back.
 */

const HIDDEN: { pattern: RegExp; keep?: (match: string) => boolean }[] = [
  { pattern: /(?<=<style\b[^>]*>)[\s\S]*?(?=<\/style>)/gi },
  { pattern: /(?<=<script\b[^>]*>)[\s\S]*?(?=<\/script>)/gi },
  // A drawing with words in it (an hours dial, a labelled map) stays, minus its geometry below.
  { pattern: /<svg\b[\s\S]*?<\/svg>/gi, keep: (svg) => /<(text|tspan|title|desc)\b/i.test(svg) },
  { pattern: /data:[^"')\s]+/gi },
  { pattern: /(?<=\b(?:class|style|d|points|transform|srcset)=")[^"]{60,}(?=")/gi },
];

const PLACEHOLDER = /⟦(\d+)⟧/g;

export interface Outline {
  text: string;
  restore(text: string): string;
}

export function elide(page: string): Outline {
  const hidden: string[] = [];
  // A page that already contains the marker could not be restored safely: show it whole.
  if (page.includes('⟦')) return { text: page, restore: (text) => text };
  let text = page;
  for (const { pattern, keep } of HIDDEN) {
    text = text.replace(pattern, (match) => {
      if (match.trim() === '' || keep?.(match)) return match;
      hidden.push(match);
      return `⟦${hidden.length - 1}⟧`;
    });
  }
  return { text, restore: (edited) => edited.replace(PLACEHOLDER, (marker, i: string) => hidden[Number(i)] ?? marker) };
}

export interface Change {
  find: string;
  replace: string;
}

/**
 * Applies the changes in order. Each `find` must occur exactly once in the text at that point. `replace` may
 * use any placeholder of the outline (a new list item copies an existing item's icon), and nothing else in
 * the placeholder brackets.
 */
export function applyChanges(text: string, changes: Change[]): { text: string } | { problems: string[] } {
  const problems: string[] = [];
  let out = text;
  for (const [i, { find, replace }] of changes.entries()) {
    const label = `change ${i + 1} (find "${find.slice(0, 80)}")`;
    const count = find ? out.split(find).length - 1 : 0;
    if (count === 0) {
      problems.push(`${label}: not found. Copy "find" exactly from the page.`);
      continue;
    }
    if (count > 1) {
      problems.push(`${label}: found ${count} times. Include more of the surrounding text so it matches once.`);
      continue;
    }
    const unknown = [...replace.matchAll(/⟦[^⟦⟧]*⟧|[⟦⟧]/g)].map(([m]) => m).filter((m) => !/^⟦\d+⟧$/.test(m) || !text.includes(m));
    if (unknown.length > 0) {
      problems.push(`${label}: "replace" has ${[...new Set(unknown)].join(', ')}, which is not a placeholder of the page. Use only placeholders that appear in the page, unchanged.`);
      continue;
    }
    out = out.replace(find, () => replace);
  }
  return problems.length > 0 ? { problems } : { text: out };
}
