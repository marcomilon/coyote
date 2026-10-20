import { isTag, isText, type AnyNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { escapeHtml } from './html';

/**
 * The owner's photo changes made in the page with no page writer, where the page already has a place for them: a
 * photo taken out of a row of photos like it, a new description on a photo the page shows, a new photo added to a
 * row of the owner's photos (a copy of the last one). Anything else needs the page writer, and is a design.
 */

function* elements(nodes: AnyNode[]): Generator<Element> {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    yield node;
    yield* elements(node.children);
  }
}

const parse = (page: string) => parseDocument(page, { lowerCaseAttributeNames: true, withStartIndices: true, withEndIndices: true });
const shows = (el: Element, file: string) => el.name === 'img' && [el.attribs.src, el.attribs.srcset].some((value) => value?.includes(file));
const imagesOf = (page: string, file: string) => [...elements(parse(page).children)].filter((el) => shows(el, file));
/** The items that hold the images, each once. */
const itemsOf = (imgs: Element[]) => [...new Map(imgs.map(itemOf).map((item) => [item.startIndex, item])).values()];

const WRAPPERS = new Set(['picture', 'figure', 'li', 'a', 'div']);

/** The element that holds one photo in the layout: the img, or the wrappers that hold nothing else (a caption aside). */
function itemOf(img: Element): Element {
  let item = img;
  for (;;) {
    const parent = item.parent;
    if (!parent || !isTag(parent) || !WRAPPERS.has(parent.name)) return item;
    const others = parent.children.filter((child) => child !== item && (isTag(child) ? !['figcaption', 'source'].includes(child.name) : isText(child) && child.data.trim() !== ''));
    if (others.length > 0) return item;
    item = parent;
  }
}

const signature = (el: Element) => `${el.name}.${el.attribs.class ?? ''}`;

/** Whether the item sits in a row of items like it that show photos too. */
const inRow = (item: Element) => (item.parent?.children ?? []).some((other) => other !== item && isTag(other) && signature(other) === signature(item) && [...elements([other])].some((el) => el.name === 'img'));

const splice = (page: string, edits: { from: number; to: number; text: string }[]) => edits.sort((a, b) => b.from - a.from).reduce((out, { from, to, text }) => out.slice(0, from) + text + out.slice(to), page);

/** The fragment with `caption` as its image's alt text and its figcaption's text; with no caption, the figcaption goes. */
function retitle(fragment: string, caption: string | undefined): string {
  const edits: { from: number; to: number; text: string }[] = [];
  for (const el of elements(parse(fragment).children)) {
    if (el.startIndex === null || el.endIndex === null) continue;
    if (el.name === 'img') {
      const tag = fragment.slice(el.startIndex, el.endIndex + 1);
      const alt = `alt="${escapeHtml(caption ?? '')}"`;
      const text = /\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i.test(tag) ? tag.replace(/\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i, alt) : tag.replace(/^<img\b/i, `<img ${alt}`);
      edits.push({ from: el.startIndex, to: el.endIndex + 1, text });
    } else if (el.name === 'figcaption') {
      const open = fragment.indexOf('>', el.startIndex) + 1;
      const close = fragment.lastIndexOf('<', el.endIndex);
      edits.push(caption ? { from: open, to: close, text: escapeHtml(caption) } : { from: el.startIndex, to: el.endIndex + 1, text: '' });
    }
  }
  return splice(fragment, edits);
}

function describe(page: string, file: string, caption: string | undefined): string | undefined {
  const imgs = imagesOf(page, file);
  if (imgs.length === 0 || !caption) return undefined;
  const edits = itemsOf(imgs).map((item) => {
    return { from: item.startIndex!, to: item.endIndex! + 1, text: retitle(page.slice(item.startIndex!, item.endIndex! + 1), caption) };
  });
  return splice(page, edits);
}

function remove(page: string, file: string): string | undefined {
  const imgs = imagesOf(page, file);
  // Shown some other way (a CSS background): the page writer takes it out.
  if (imgs.length === 0) return page.includes(file) ? undefined : page;
  const items = itemsOf(imgs);
  if (!items.every(inRow)) return undefined;
  return splice(page, items.map((item) => ({ from: item.startIndex!, to: item.endIndex! + 1, text: '' })));
}

function add(page: string, files: string[], ownerPhotos: string[], captions: Record<string, string>): string | undefined {
  // The last of the owner's photos that sits in a row of photos: the new ones follow it, copied from it.
  const rows = [...elements(parse(page).children)].flatMap((el) => {
    const shown = ownerPhotos.find((photo) => shows(el, photo));
    const item = shown && itemOf(el);
    return item && inRow(item) ? [{ item, shown }] : [];
  });
  const last = rows.at(-1);
  if (!last) return undefined;
  const model = page.slice(last.item.startIndex!, last.item.endIndex! + 1);
  // A copy that shows anything but that one photo would show it twice.
  if (/assets\/gen-/.test(model) || ownerPhotos.some((photo) => photo !== last.shown && model.includes(photo))) return undefined;
  const copies = files.map((file) => retitle(model.split(last.shown).join(file), captions[file]));
  return splice(page, [{ from: last.item.endIndex! + 1, to: last.item.endIndex! + 1, text: copies.join('') }]);
}

/**
 * The page with the photo change made, or undefined when it needs the page writer. `ownerPhotos`: the owner's photos
 * before the change; `captions`: the descriptions after it. A logo is never handled here (logo.ts).
 */
export function changePhotosInPlace(page: string, change: { added: string[]; removed: string[]; described?: string[] }, ownerPhotos: string[], captions: Record<string, string> = {}): string | undefined {
  let out: string | undefined = page;
  for (const file of change.described ?? []) out = out && describe(out, file, captions[file]);
  if (out && change.added.length > 0) out = add(out, change.added, ownerPhotos.filter((photo) => !change.removed.includes(photo)), captions);
  for (const file of change.removed) out = out && remove(out, file);
  return out;
}
