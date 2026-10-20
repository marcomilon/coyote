import { isTag, isText, type AnyNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';

/**
 * Whether a chat edit stayed an update of the current design. An update reuses the page's building blocks: its tags,
 * classes, inline styles, scripts, and stylesheets, copied as they are, plus new values for the colors and fonts the
 * page sets in `:root`. Anything else is design work, for the page writer ("Rediseñar"). Checked in code, not left
 * to the chat model's judgment.
 */

function* elements(nodes: AnyNode[]): Generator<Element> {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    yield node;
    yield* elements(node.children);
  }
}

const textOf = (el: Element) => el.children.map((child) => (isText(child) ? child.data : '')).join('');

function parts(page: string) {
  const dom = parseDocument(page, { lowerCaseAttributeNames: true });
  const tags = new Set<string>();
  const classes = new Set<string>();
  const styles = new Set<string>();
  const handlers = new Set<string>();
  const scripts: string[] = [];
  const links: string[] = [];
  const css: string[] = [];
  for (const el of elements(dom.children)) {
    tags.add(el.name);
    for (const name of (el.attribs.class ?? '').split(/\s+/).filter(Boolean)) classes.add(name);
    if (el.attribs.style !== undefined) styles.add(el.attribs.style.trim());
    for (const [name, value] of Object.entries(el.attribs)) if (name.startsWith('on')) handlers.add(`${name}=${value}`);
    if (el.name === 'script') scripts.push(`${el.attribs.src ?? ''}|${textOf(el)}`);
    if (el.name === 'link') links.push(`${el.attribs.rel ?? ''}|${el.attribs.href ?? ''}`);
    if (el.name === 'style') css.push(textOf(el));
  }
  return { tags, classes, styles, handlers, scripts: scripts.sort().join('\n'), links: links.sort().join('\n'), css: css.join('\n</style>\n') };
}

const ROOT = /:root\s*\{[^{}]*\}/g;
const TOKEN = /(--[\w-]+)(\s*:\s*)([^;}]*)/g;

/** The custom properties of each `:root` block, and the styles with their values taken out. */
function tokens(css: string) {
  const values = new Map<string, string>();
  let block = 0;
  const skeleton = css.replace(ROOT, (root) => {
    block++;
    return root.replace(TOKEN, (_all, name: string, colon: string, value: string) => {
      values.set(`${block}${name}`, value.trim());
      return `${name}${colon}`;
    });
  });
  return { values, skeleton };
}

const COLOR = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\))$/i;
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math)$/i;
const families = (value: string) =>
  value
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
const isFontStack = (value: string) => families(value).some((f) => GENERIC.test(f));

/** What makes the edit more than an update; empty when it is one. */
export function editScope(before: string, after: string): string[] {
  const old = parts(before);
  const now = parts(after);
  const problems: string[] = [];
  const added = (kind: string, was: Set<string>, is: Set<string>) => {
    const extra = [...is].filter((x) => !was.has(x));
    if (extra.length > 0) problems.push(`new ${kind}: ${extra.slice(0, 5).join(', ')}`);
  };
  added('tags', old.tags, now.tags);
  added('classes', old.classes, now.classes);
  added('inline styles', old.styles, now.styles);
  added('event handlers', old.handlers, now.handlers);
  if (old.scripts !== now.scripts) problems.push('scripts changed');
  if (old.links !== now.links) problems.push('stylesheets or fonts changed');

  const was = tokens(old.css);
  const is = tokens(now.css);
  if (was.skeleton !== is.skeleton) problems.push('styles changed beyond the :root colors and fonts');
  else {
    // The fonts the page loads or names already; a new one would need a new stylesheet.
    const known = before.toLowerCase().replace(/\+/g, ' ');
    for (const [key, value] of is.values) {
      const prior = was.values.get(key);
      if (prior === undefined || prior === value) continue;
      const name = key.replace(/^\d+/, '');
      if (COLOR.test(prior)) {
        if (!COLOR.test(value)) problems.push(`${name}: "${value}" is not a color`);
      } else if (isFontStack(prior)) {
        const unknown = families(value).filter((f) => !GENERIC.test(f) && !known.includes(f.toLowerCase()));
        if (!isFontStack(value) || unknown.length > 0) problems.push(`${name}: "${value}" is not a font the page loads`);
      } else problems.push(`${name}: only colors and fonts may change`);
    }
  }
  return problems;
}
