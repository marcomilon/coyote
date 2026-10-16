import { Element, type AnyNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { escapeHtml } from './html';

/**
 * The page's logo spot, tagged by our code (never asked of the page writer: rules in its prompt made the designs
 * worse). Every written page gets `data-logo` on its brand link, the first link in the header that is classed as a
 * logo or brand or names the business, and `data-logo-mark` on the brand's image: the owner's logo, or the mark the
 * writer drew (an inline SVG, or an empty element classed as a mark or icon). A new logo then goes there with no
 * page writer: in place of the mark, or before the name when the brand is only text.
 */

const isElement = (node: AnyNode): node is Element => node instanceof Element;

function* elements(nodes: AnyNode[]): Generator<Element> {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    yield node;
    yield* elements(node.children);
  }
}

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const textOf = (el: Element): string => [...el.children].map((child) => ('data' in child && child.type === 'text' ? child.data : isElement(child) ? textOf(child) : '')).join(' ');

const BRAND = /(^|[\s_-])(logo|brand|marca)/i;
const MARK = /(^|[\s_-])(mark|icon|emblem|symbol|isotipo|logo-?img)/i;

function findBrand(nodes: AnyNode[], businessName: string): Element | undefined {
  const all = [...elements(nodes)];
  const header = all.find((el) => el.name === 'header') ?? all.find((el) => el.name === 'nav');
  if (!header) return undefined;
  const name = words(businessName);
  return [...elements(header.children)].find((el) => {
    if (el.name !== 'a' || /^(https?:|tel:|mailto:|sms:)/i.test(el.attribs.href ?? '')) return false;
    if (BRAND.test(el.attribs.class ?? '') || BRAND.test(el.attribs.id ?? '')) return true;
    return name.length > 0 && words(`${el.attribs['aria-label'] ?? ''} ${textOf(el)}`).includes(name);
  });
}

function findMark(brand: Element): Element | undefined {
  const inside = [...elements(brand.children)];
  return (
    inside.find((el) => el.name === 'img') ??
    inside.find((el) => el.name === 'svg') ??
    inside.find((el) => (MARK.test(el.attribs.class ?? '') || el.attribs['aria-hidden'] === 'true') && !words(textOf(el)) && el.name !== 'use')
  );
}

const parse = (page: string) => parseDocument(page, { lowerCaseAttributeNames: true, withStartIndices: true, withEndIndices: true });

/** Adds the tags to a written page. A page already tagged, or with no brand found, comes back as it was. */
export function tagLogo(page: string, businessName: string): string {
  const dom = parse(page);
  if ([...elements(dom.children)].some((el) => 'data-logo' in el.attribs)) return page;
  const brand = findBrand(dom.children, businessName);
  if (!brand || brand.startIndex === null) return page;
  const mark = findMark(brand);
  // Attributes go in right after each tag's name, the later one first so the earlier index stays right.
  const inserts = [{ at: brand.startIndex + 1 + brand.name.length, text: ' data-logo' }];
  if (mark?.startIndex != null) inserts.push({ at: mark.startIndex + 1 + mark.name.length, text: ' data-logo-mark' });
  return inserts.sort((a, b) => b.at - a.at).reduce((out, { at, text }) => out.slice(0, at) + text + out.slice(at), page);
}

/** Whether a new logo can go into this page with no page writer. */
export const hasLogoSpot = (page: string) => /<a\b[^>]*\sdata-logo[\s>=]/i.test(page);

/** The page with `logo` in its logo spot, or undefined when it has none (the page writer places it then). */
export function placeLogo(page: string, logo: string, businessName: string): string | undefined {
  const dom = parse(page);
  const brand = [...elements(dom.children)].find((el) => el.name === 'a' && 'data-logo' in el.attribs);
  if (!brand || brand.startIndex === null || brand.endIndex === null) return undefined;
  const mark = [...elements(brand.children)].find((el) => 'data-logo-mark' in el.attribs);
  // The brand link usually names the business already (aria-label or text); then the image is decoration.
  const alt = brand.attribs['aria-label'] || words(textOf(brand)) ? '' : businessName;
  const style = `height:2.5em;max-height:64px;width:auto;max-width:200px;object-fit:contain;display:inline-block;vertical-align:middle${mark ? '' : ';margin-inline-end:.5em'}`;
  const img = `<img src="${escapeHtml(logo)}" alt="${escapeHtml(alt)}" data-logo-mark style="${style}">`;
  if (mark && mark.startIndex !== null && mark.endIndex !== null) return page.slice(0, mark.startIndex) + img + page.slice(mark.endIndex + 1);
  const at = brand.children[0]?.startIndex ?? brand.endIndex - 3; // before the first child, or right before </a>
  return page.slice(0, at) + img + page.slice(at);
}
