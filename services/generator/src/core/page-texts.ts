import { Element, type AnyNode, type Text } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { Contact } from './content';
import { escapeHtml } from './html';
import { addressPattern, localForms, numberPattern, showsContact } from './page-check';

/**
 * Mi sitio → Tus textos: every text a visitor reads on the written page, as a list the owner edits directly.
 * Each entry is a block (a paragraph, a heading, a list item, a button), however it is formatted inside:
 * `Pan <strong>recién</strong> horneado` is one entry. The owner's new text is mapped back word by word, so
 * kept words stay in their formatting and a changed word takes the place of the one it replaces; the rest of
 * the page stays exactly as Opus wrote it, and no model is called. Words a script writes, styles, and drawings'
 * geometry are not listed; the chat still changes those.
 */

export interface PageText {
  /** Its place in the list. Saving sends it back with the text it had, so a page changed meanwhile is caught. */
  id: number;
  text: string;
  /** The heading of the part of the page it is in (none before the first heading). */
  group?: string;
  /** The page's title and description, as search engines show them. */
  kind?: 'title' | 'description';
  /** What it is on the page (a heading, a button…), from its element, for the field's label. */
  role?: Role;
  /** Texts in the same card (a repeated item: a numbered point, a service, a contact card) share this number. */
  card?: number;
  /** Shows the owner's contact details: a change to one changes the site's contact too (`contactChanges`), links and all. */
  showsContact?: true;
}

export interface TextEdit {
  id: number;
  from: string;
  to: string;
}

/** A piece of a block's text in the source: a text node, or an empty spot at the block's start or end. */
interface Piece {
  start: number;
  end: number;
  data: string;
  /** Inline elements between it and the block: new words at a boundary go to the plainer side. */
  depth: number;
  /** A text node's element. */
  parent?: AnyNode | null;
  write(text: string): string;
}

export const ROLES = ['headline', 'heading', 'subheading', 'paragraph', 'button', 'menu', 'link', 'item', 'table', 'caption', 'quote', 'label', 'footer', 'text'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_OF: Record<string, Role> = {
  h1: 'headline', h2: 'heading', h3: 'subheading', h4: 'subheading', h5: 'subheading', h6: 'subheading',
  p: 'paragraph', li: 'item', dt: 'item', dd: 'item', td: 'table', th: 'table', figcaption: 'caption', caption: 'caption',
  blockquote: 'quote', q: 'quote', label: 'label', legend: 'label', summary: 'label', address: 'paragraph', option: 'item', button: 'button',
};
const BUTTON_CLASS = /\b(btn|button|rounded-full|px-\d)/i;

const inside = (node: AnyNode, names: string[]): boolean => {
  for (let parent = node.parent; parent; parent = parent.parent) if (isElement(parent) && names.includes(parent.name)) return true;
  return false;
};

function roleOf(block: AnyNode): Role {
  if (!isElement(block)) return 'text';
  const role = ROLE_OF[block.name];
  if (role === 'headline' || role === 'heading' || role === 'subheading' || role === 'button') return role;
  // A link alone (not in a paragraph): a menu entry, or a button.
  if (block.name === 'a') {
    if (block.attribs.role === 'button' || BUTTON_CLASS.test(block.attribs.class ?? '')) return 'button';
    if (inside(block, ['nav', 'header'])) return 'menu';
    return inside(block, ['footer']) ? 'footer' : 'button';
  }
  if (inside(block, ['nav'])) return 'menu';
  if (inside(block, ['footer'])) return 'footer';
  return role ?? 'text';
}

interface Slot extends PageText {
  pieces: Piece[];
  node?: AnyNode;
}

const HIDDEN = ['script', 'style', 'noscript', 'template'];
/** Formatting inside a block. A run of these alone in a layout element (buttons in a row) is a block of its own. */
const INLINE = new Set('a abbr b bdi bdo br cite code data del dfn em font i ins kbd mark q s samp small span strong sub sup time tspan u var wbr'.split(' '));
/** Elements whose text reads as one, even when it is all inside formatting (`<h1><span>Panadería</span> <span>Rosa</span></h1>`). */
const TEXT_BLOCKS = new Set('p h1 h2 h3 h4 h5 h6 li dt dd td th blockquote figcaption caption label button summary legend address pre option title'.split(' '));
const READABLE = /[\p{L}\p{N}]/u;
const TOKEN = /\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const isElement = (node: AnyNode): node is Element => node instanceof Element;
const isText = (node: AnyNode): node is Text => node.type === 'text';
const textOf = (node: AnyNode): string =>
  isText(node) ? node.data : !isElement(node) || HIDDEN.includes(node.name) ? '' : node.name === 'br' ? ' ' : node.children.map(textOf).join('');
const readsAsText = (el: Element) => TEXT_BLOCKS.has(el.name) || el.children.some((child) => isText(child) && READABLE.test(child.data));

const within = (node: AnyNode | null | undefined, ancestor: AnyNode | null | undefined): boolean => !!node && (node === ancestor || within(node.parent, ancestor));

/**
 * Texts in sibling elements with nothing between them (`<span class="block">Panadería</span><span>Rosa</span>`,
 * a name and its price in a row): the layout sets them apart, so the list shows a space there. It is not in the
 * source: new words written at it go into the next text.
 */
const touching = (a: Piece, b: Piece) =>
  !!a.parent && !!b.parent && !/\s$/.test(a.data) && !/^\s/.test(b.data) && !within(a.parent, b.parent) && !within(b.parent, a.parent);

/** The block a text node or line break belongs to, and how many inline elements are in between. */
function blockOf(node: AnyNode): { block: AnyNode; depth: number } {
  const inline: Element[] = [];
  let parent = node.parent;
  while (parent && isElement(parent) && INLINE.has(parent.name)) {
    inline.push(parent);
    parent = parent.parent;
  }
  if (parent && isElement(parent) && readsAsText(parent)) return { block: parent, depth: inline.length };
  // Formatting alone in a layout element: its outermost element is the block.
  const top = inline.at(-1);
  return top ? { block: top, depth: inline.length - 1 } : { block: node, depth: 0 };
}

function slots(page: string, contact: Contact): Slot[] {
  const dom = parseDocument(page, { lowerCaseAttributeNames: true, withStartIndices: true, withEndIndices: true });
  const blocks = new Map<AnyNode, Omit<Slot, 'id' | 'text'>>();
  let group: string | undefined;
  const text = (data: string): Pick<Piece, 'data' | 'write'> => ({ data, write: escapeHtml });

  const visit = (node: AnyNode, inHead: boolean) => {
    if (isText(node)) {
      const parent = node.parent && isElement(node.parent) ? node.parent.name : undefined;
      // In the head only the title is read; in the body, a drawing's title and description are not shown.
      if (inHead ? parent !== 'title' : parent === 'title' || parent === 'desc') return;
      if (node.startIndex === null || node.endIndex === null) return;
      const { block, depth } = blockOf(node);
      if (!blocks.has(block)) blocks.set(block, { pieces: [], ...(inHead ? { kind: 'title' as const } : { group }) });
      blocks.get(block)!.pieces.push({ start: node.startIndex, end: node.endIndex + 1, depth, parent: node.parent, ...text(node.data) });
      return;
    }
    if (!isElement(node) || HIDDEN.includes(node.name)) return;
    if (node.name === 'br' && !inHead && node.startIndex !== null && node.endIndex !== null) {
      // Reads as a space. It stays while the owner keeps that space; words after it go after it.
      const { block, depth } = blockOf(node);
      const tag = page.slice(node.startIndex, node.endIndex + 1);
      blocks.get(block)?.pieces.push({ start: node.startIndex, end: node.endIndex + 1, depth, data: ' ', write: (next) => (/^\s/.test(next) ? tag + escapeHtml(next.slice(1)) : escapeHtml(next)) });
      return;
    }
    if (node.name === 'meta' && node.attribs.name?.toLowerCase() === 'description' && node.startIndex !== null && node.endIndex !== null) {
      // The value as written in the tag, entities and quotes included.
      const tag = page.slice(node.startIndex, node.endIndex + 1);
      const value = /(\scontent\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
      if (value) {
        const start = node.startIndex + value.index + value[1]!.length;
        const piece = { start, end: start + value[2]!.length, depth: 0, data: node.attribs.content ?? '', write: (next: string) => `"${escapeHtml(next)}"` };
        blocks.set(node, { pieces: [piece], kind: 'description' });
      }
      return;
    }
    if (/^h[12]$/.test(node.name)) group = collapse(textOf(node)).slice(0, 80) || group;
    node.children.forEach((child) => visit(child, inHead || node.name === 'head'));
  };
  dom.children.forEach((node) => visit(node, false));

  const out: Slot[] = [];
  for (const [block, slot] of blocks) {
    slot.pieces = slot.pieces.flatMap((piece, k) => {
      const before = slot.pieces[k - 1];
      return before && touching(before, piece) ? [{ start: piece.start, end: piece.start, depth: piece.depth, data: ' ', write: (next: string) => escapeHtml(next.replace(/^\s/, '')) }, piece] : [piece];
    });
    const joined = collapse(slot.pieces.map((p) => p.data).join(''));
    if (!READABLE.test(joined)) continue;
    // Empty spots at the block's start and end, so new words there need not go inside formatting.
    if (isElement(block) && slot.kind !== 'description') {
      const first = block.children[0]!.startIndex!;
      const last = block.children.at(-1)!.endIndex! + 1;
      slot.pieces = [{ start: first, end: first, depth: 0, ...text('') }, ...slot.pieces, { start: last, end: last, depth: 0, ...text('') }];
    }
    out.push({ ...slot, id: out.length, text: joined, node: block, ...(!slot.kind && { role: roleOf(block) }), ...(showsContact(joined, contact) && { showsContact: true }) });
  }
  markCards(out);
  return out;
}

/** Most texts a card holds; more is a section. */
const CARD_MAX = 8;

/**
 * Cards: the largest element around a text that holds 2 to CARD_MAX texts, no h1 or h2 (that is a section), and
 * sits next to other elements with texts (an item among items, not a wrapper). An element holding two alike
 * children with texts each is a list of cards, not a card. Texts in one card share `card`.
 */
function markCards(slots: Slot[]): void {
  const count = new Map<AnyNode, number>();
  const major = new Set<AnyNode>();
  for (const slot of slots) {
    if (slot.kind) continue;
    const big = slot.role === 'headline' || slot.role === 'heading';
    for (let node = slot.node?.parent; node; node = node.parent) {
      count.set(node, (count.get(node) ?? 0) + 1);
      if (big) major.add(node);
    }
  }
  const withTexts = (node: AnyNode) => (count.get(node) ?? 0) > 0 || slots.some((slot) => slot.node === node);
  // Two children alike (same tag and class) with texts each: repeated items.
  const listOfCards = (node: AnyNode) => {
    if (!('children' in node)) return false;
    const seen = new Set<string>();
    for (const child of node.children) {
      if ((count.get(child) ?? 0) < 2 || !isElement(child)) continue;
      const kind = `${child.name}.${child.attribs.class ?? ''}`;
      if (seen.has(kind)) return true;
      seen.add(kind);
    }
    return false;
  };
  const ids = new Map<AnyNode, number>();
  for (const slot of slots) {
    if (slot.kind) continue;
    let card: AnyNode | undefined;
    for (let node = slot.node?.parent; node && (count.get(node) ?? 0) <= CARD_MAX && !major.has(node) && !listOfCards(node); node = node.parent) {
      const siblings = node.parent && 'children' in node.parent ? node.parent.children.filter(withTexts).length : 0;
      if (count.get(node)! >= 2 && siblings >= 2) card = node;
    }
    if (!card) continue;
    if (!ids.has(card)) ids.set(card, ids.size);
    slot.card = ids.get(card)!;
  }
}

/** The page's texts, in reading order. */
export const pageTexts = (page: string, contact: Contact): PageText[] => slots(page, contact).map(({ pieces: _pieces, node: _node, ...text }) => text);

/**
 * The block's new text, split back into its pieces: a word or space the owner kept stays in its piece; new words
 * take the piece of the first word they replace, or, added between two kept words, the plainer of their pieces.
 */
function split(pieces: Piece[], to: string): string[] {
  const old = pieces.flatMap((piece, i) => (piece.data.match(TOKEN) ?? []).map((token) => ({ token, piece: i })));
  const next = to.match(TOKEN) ?? [];
  const same = (a: string, b: string) => a === b || (/^\s/.test(a) && /^\s/.test(b));
  // Longest common subsequence of the tokens.
  const n = old.length;
  const m = next.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = same(old[i]!.token, next[j]!) ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const out = pieces.map(() => '');
  const plainer = (a: number, b: number) => (pieces[b]!.depth < pieces[a]!.depth ? b : a);
  let i = 0;
  let j = 0;
  let kept = 0; // the piece of the last kept token (the empty spot at the start, before any)
  while (i < n || j < m) {
    // A changed run: the old tokens it drops and the new tokens it brings, up to the next kept token.
    const removed: number[] = [];
    const added: string[] = [];
    while (i < n || j < m) {
      if (i < n && j < m && same(old[i]!.token, next[j]!) && lcs[i * (m + 1) + j] === lcs[(i + 1) * (m + 1) + j + 1]! + 1) break;
      if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) removed.push(old[i++]!.piece);
      else added.push(next[j++]!);
    }
    if (added.length > 0) {
      const after = i < n ? old[i]!.piece : pieces.length - 1;
      out[removed[0] ?? plainer(kept, after)] += added.join('');
    }
    if (i < n && j < m) {
      kept = old[i]!.piece;
      out[kept] += old[i]!.token; // as written, with its own spacing
      i++;
      j++;
    }
  }
  return out;
}

/**
 * Writes the owner's texts into the page. `stale`: an entry is gone or no longer has the text it had (the page
 * changed since the list was read). A contact detail edited in a text changes only that text here; `contactChanges`
 * finds it, so the caller swaps it everywhere else.
 */
export function editTexts(page: string, edits: TextEdit[], contact: Contact): { page: string } | { problem: 'stale' } {
  const all = slots(page, contact);
  const writes: { piece: Piece; text: string }[] = [];
  for (const { id, from, to } of edits) {
    const slot = all[id];
    if (!slot || slot.text !== collapse(from)) return { problem: 'stale' };
    if (collapse(to) === slot.text) continue;
    split(slot.pieces, collapse(to)).forEach((text, k) => {
      if (text !== slot.pieces[k]!.data) writes.push({ piece: slot.pieces[k]!, text });
    });
  }
  let out = page;
  // From the end, so the earlier positions still hold; an empty spot goes before the text that starts there.
  writes.sort((a, b) => b.piece.start - a.piece.start || b.piece.end - a.piece.end);
  for (const { piece, text } of writes) out = out.slice(0, piece.start) + piece.write(text) + out.slice(piece.end);
  return { page: out };
}

/** Most owner's texts a site remembers. */
const OWNER_TEXTS_MAX = 200;

/**
 * The texts the owner wrote, after an owner's change (Tus textos, the chat): the earlier ones still on the page,
 * and the ones the change put there. A redesign keeps them (`restoreTexts`).
 */
export function ownerTextsAfter(before: string, after: string, contact: Contact, previous: string[] = []): string[] {
  const old = new Set(pageTexts(before, contact).map((t) => t.text));
  const now = pageTexts(after, contact).map((t) => t.text);
  const onPage = new Set(now);
  return [...new Set([...previous.filter((text) => onPage.has(text)), ...now.filter((text) => !old.has(text))])].slice(-OWNER_TEXTS_MAX);
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const wordsOf = (text: string) => new Set(fold(text).match(/[\p{L}\p{N}]+/gu) ?? []);
/** Shared words over all words (Jaccard). */
function alike(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1);
}
/** The owner's request names this text (a word of 5+ letters from it): the redesign may change it. */
const mentioned = (text: string, instruction: string) => {
  const asked = wordsOf(instruction);
  return [...wordsOf(text)].some((w) => w.length >= 5 && asked.has(w));
};

export interface Restored {
  page: string;
  /** Still on the page as the owner wrote them, or put back. */
  kept: string[];
  restored: string[];
  /** No place for them in the new design. Texts the request names are in none of the lists. */
  lost: string[];
}

const CONTACT_FIELDS = ['whatsapp', 'phone', 'email', 'instagram', 'facebook', 'address'] as const;
/** What a new detail of each kind looks like, when the words around the old one changed too. */
const NEW_DETAIL: Partial<Record<keyof Contact, RegExp>> = {
  whatsapp: /\+?\d[\d\s().-]{5,}\d/g,
  phone: /\+?\d[\d\s().-]{5,}\d/g,
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  instagram: /@[A-Za-z0-9._]{1,30}|instagram\.com\/[A-Za-z0-9._]{1,30}/gi,
  facebook: /facebook\.com\/[A-Za-z0-9.-]{1,50}/gi,
};

/** Where a text shows a contact detail, and the form it is written in (a number may lack its country code). */
function findDetail(field: keyof Contact, value: string, text: string): { start: number; end: number; form: string } | undefined {
  if (field === 'whatsapp' || field === 'phone') {
    for (const form of [value, ...localForms(value)].filter((f) => f.length >= 7)) {
      const match = numberPattern(form).exec(text);
      if (match) return { start: match.index, end: match.index + match[0].length, form };
    }
    return undefined;
  }
  if (field === 'address') {
    const match = addressPattern(value)?.exec(text) ?? (text.includes(value) ? { index: text.indexOf(value), 0: value } : null);
    return match ? { start: match.index, end: match.index + match[0].length, form: value } : undefined;
  }
  const at = text.toLowerCase().indexOf(value.toLowerCase());
  return at >= 0 ? { start: at, end: at + value.length, form: value } : undefined;
}

const digitsOf = (text: string) => text.replace(/\D/g, '').replace(/^00/, '');

/**
 * Mi sitio → Tus textos: the contact details the owner changed by editing a text that shows them. The new detail is
 * what took the old one's place (the words around it kept), or else the one new number, email or handle the text
 * gained. A number written without its country code keeps the old one's. A detail taken out of a text leaves the
 * contact as it is. Raw values: the caller cleans and checks them.
 */
export function contactChanges(edits: TextEdit[], contact: Contact): Partial<Record<keyof Contact, string>> {
  const out: Partial<Record<keyof Contact, string>> = {};
  for (const edit of edits) {
    const before = collapse(edit.from);
    const after = collapse(edit.to);
    if (before === after) continue;
    for (const field of CONTACT_FIELDS) {
      const value = contact[field];
      if (!value || out[field] !== undefined) continue;
      const found = findDetail(field, value, before);
      if (!found || findDetail(field, value, after)) continue;
      const prefix = before.slice(0, found.start);
      const suffix = before.slice(found.end);
      let next: string | undefined;
      if (after.length >= prefix.length + suffix.length && after.startsWith(prefix) && after.endsWith(suffix)) next = after.slice(prefix.length, after.length - suffix.length).trim();
      else {
        const gained = [...after.matchAll(NEW_DETAIL[field] ?? /$^/g)].map((m) => m[0]).filter((d) => !before.toLowerCase().includes(d.toLowerCase()));
        if (gained.length === 1) next = gained[0];
      }
      if (!next) continue;
      if (field === 'whatsapp' || field === 'phone') {
        const digits = digitsOf(next);
        if (!digits) continue;
        next = digits.length === found.form.length && found.form !== value ? value.slice(0, value.length - found.form.length) + digits : digits;
      }
      out[field] = next;
    }
  }
  return out;
}

/**
 * After a redesign: each text the owner wrote that the new page reworded goes back into the entry that took its
 * place (the most alike with the same role, at least half the words shared), unless the request asked to change it.
 */
export function restoreTexts(before: string, after: string, keep: string[], instruction: string, contact: Contact): Restored {
  const role = new Map(pageTexts(before, contact).map((t) => [t.text, t.kind ?? t.role]));
  const entries = pageTexts(after, contact);
  const present = new Set(entries.map((t) => t.text));
  const taken = new Set<number>();
  const edits: TextEdit[] = [];
  const out: Restored = { page: after, kept: [], restored: [], lost: [] };
  for (const text of keep) {
    if (present.has(text)) {
      out.kept.push(text);
      continue;
    }
    if (mentioned(text, instruction)) continue;
    let best: { entry: PageText; score: number } | undefined;
    for (const entry of entries) {
      if (taken.has(entry.id) || entry.showsContact || keep.includes(entry.text) || (entry.kind ?? entry.role) !== role.get(text)) continue;
      const score = alike(text, entry.text);
      if (score >= 0.5 && score > (best?.score ?? 0)) best = { entry, score };
    }
    if (!best) {
      out.lost.push(text);
      continue;
    }
    taken.add(best.entry.id);
    edits.push({ id: best.entry.id, from: best.entry.text, to: text });
    out.restored.push(text);
  }
  if (edits.length === 0) return out;
  const edited = editTexts(after, edits, contact);
  if (!('page' in edited)) return { ...out, restored: [], lost: [...out.lost, ...out.restored] };
  return { ...out, page: edited.page, kept: [...out.kept, ...out.restored] };
}
