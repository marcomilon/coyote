import render from 'dom-serializer';
import { Element, Text, type AnyNode, type ChildNode, type Document, type ParentNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { z } from 'zod';
import type { Answers, PageGoal } from './answers';
import type { Contact, Media } from './content';
import { IMAGE_ASPECTS, type ImageAspect } from './page-writer';
import { nationalNumber } from './phones';

/**
 * Template pages (`./coyote.sh page-mode template`): Opus designs a page once, with placeholders marked by data
 * attributes; for each site a cheaper model writes the words (`fill_page`) and this module fills them in. Contact
 * links, the business name, the address and the head (title, description, structured data) come from our code.
 *
 * - `data-text="hero_title" data-max="60"`: the element's text. `data-optional`: may be left empty (the element goes).
 *   `business_name` and `address` are filled from the form.
 * - `data-repeat="services" data-min="3" data-max="6"`: an item cloned once per entry; its `data-text` children are the entry's fields.
 * - `data-image="hero" data-aspect="16:9"`: a wrapper whose drawn fallback is replaced by a photo when there is one. `logo`: the owner's logo, or gone.
 * - `data-contact="whatsapp|phone|email|instagram|facebook|maps"` on a link: href from the contact details;
 *   `data-contact-label` also sets its text. Gone when the owner has no such detail.
 * - `data-if="<contact or slot>"`: the element goes when that contact detail or slot is empty.
 * - `data-goal="whatsapp|call|visit|book"`: alternative main buttons under one parent; the owner's goal wins, else the first.
 */

export const CONTACT_KINDS = ['whatsapp', 'phone', 'email', 'instagram', 'facebook', 'maps'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
/** Text slots our code fills, never the model. */
export const RESERVED_TEXTS = ['business_name', 'address'] as const;
const GOAL_BUTTONS = ['whatsapp', 'call', 'visit', 'book'] as const;
const DEFAULT_TEXT_MAX = 160;
const SLOT_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface TextSlot {
  name: string;
  max: number;
  optional: boolean;
  /** The template's own text, shown to the filler as an example of length and tone. */
  sample: string;
}
export interface RepeatSlot {
  name: string;
  min: number;
  max: number;
  fields: TextSlot[];
}
export interface ImageSlot {
  name: string;
  aspect: ImageAspect;
}
export interface Manifest {
  texts: TextSlot[];
  repeats: RepeatSlot[];
  images: ImageSlot[];
  contacts: ContactKind[];
  /** Why the template can't be used. Empty: it can. */
  errors: string[];
}

const isElement = (node: AnyNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';
const textOf = (node: AnyNode): string => (node.type === 'text' ? (node as Text).data : 'children' in node ? (node as ParentNode).children.map(textOf).join('') : '');
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function walk(node: AnyNode, visit: (el: Element) => boolean | void): void {
  if (!isElement(node) && node.type !== 'root') return;
  if (isElement(node) && visit(node) === false) return;
  for (const child of [...(node as ParentNode).children]) walk(child, visit);
}

function textSlot(el: Element, errors: string[]): TextSlot | undefined {
  const name = el.attribs['data-text']!;
  if (!SLOT_NAME.test(name)) return void errors.push(`bad data-text name "${name}"`);
  const max = Number(el.attribs['data-max'] ?? DEFAULT_TEXT_MAX);
  if (!Number.isInteger(max) || max < 5 || max > 1200) errors.push(`data-text="${name}": data-max must be a number from 5 to 1200`);
  if (el.children.some(isElement)) errors.push(`data-text="${name}" holds other elements; it must hold text only`);
  return { name, max: Math.min(Math.max(max || DEFAULT_TEXT_MAX, 5), 1200), optional: 'data-optional' in el.attribs, sample: clean(textOf(el)).slice(0, 300) };
}

/** Merges repeated uses of one slot name: the shortest limit wins, and it is optional only if every use is. */
function addSlot(slots: TextSlot[], slot: TextSlot): void {
  const seen = slots.find((s) => s.name === slot.name);
  if (!seen) slots.push(slot);
  else Object.assign(seen, { max: Math.min(seen.max, slot.max), optional: seen.optional && slot.optional });
}

/** What a template asks for. The page must have a head and a body, a hero title, a WhatsApp link, and a photo slot. */
export function parseTemplate(html: string): Manifest {
  const dom = parseDocument(html, { lowerCaseAttributeNames: true });
  const errors: string[] = [];
  const texts: TextSlot[] = [];
  const repeats: RepeatSlot[] = [];
  const images: ImageSlot[] = [];
  const contacts = new Set<ContactKind>();

  walk(dom, (el) => {
    const a = el.attribs;
    if (a['data-repeat'] !== undefined) {
      const name = a['data-repeat'];
      if (!SLOT_NAME.test(name)) errors.push(`bad data-repeat name "${name}"`);
      const min = Number(a['data-min'] ?? 1);
      const max = Number(a['data-max'] ?? 6);
      if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && min <= max && max <= 12)) errors.push(`data-repeat="${name}": data-min/data-max must be 1 ≤ min ≤ max ≤ 12`);
      const fields: TextSlot[] = [];
      walk(el, (inner) => {
        if (inner === el) return;
        if (inner.attribs['data-repeat'] !== undefined) errors.push(`data-repeat="${name}" holds another repeat`);
        if (inner.attribs['data-image'] !== undefined) errors.push(`data-repeat="${name}" holds an image slot; images can't repeat`);
        if (inner.attribs['data-text'] !== undefined) {
          const slot = textSlot(inner, errors);
          if (slot && !(RESERVED_TEXTS as readonly string[]).includes(slot.name)) addSlot(fields, slot);
        }
        if (inner.attribs['data-contact'] !== undefined) contactAttr(inner.attribs['data-contact'], contacts, errors);
      });
      if (fields.length === 0) errors.push(`data-repeat="${name}" has no data-text fields`);
      const seen = repeats.find((r) => r.name === name);
      if (!seen) repeats.push({ name, min, max, fields });
      return false;
    }
    if (a['data-text'] !== undefined) {
      const slot = textSlot(el, errors);
      if (slot && !(RESERVED_TEXTS as readonly string[]).includes(slot.name)) addSlot(texts, slot);
    }
    if (a['data-image'] !== undefined) {
      const name = a['data-image'];
      const aspect = (a['data-aspect'] ?? '3:2') as ImageAspect;
      if (!SLOT_NAME.test(name)) errors.push(`bad data-image name "${name}"`);
      if (!IMAGE_ASPECTS.includes(aspect)) errors.push(`data-image="${name}": data-aspect must be one of ${IMAGE_ASPECTS.join(', ')}`);
      if (name !== 'logo' && !images.some((i) => i.name === name)) images.push({ name, aspect });
    }
    if (a['data-contact'] !== undefined) contactAttr(a['data-contact'], contacts, errors);
  });

  const htmlEl = dom.children.find((n): n is Element => isElement(n) && n.name === 'html');
  if (!htmlEl?.children.some((n) => isElement(n) && n.name === 'head') || !htmlEl.children.some((n) => isElement(n) && n.name === 'body')) errors.push('not a complete HTML document (html, head, body)');
  if (!texts.some((t) => t.name === 'hero_title')) errors.push('no data-text="hero_title"');
  if (!contacts.has('whatsapp')) errors.push('no data-contact="whatsapp" link');
  if (images.length === 0) errors.push('no data-image slot (besides the logo)');
  const names = [...texts.map((t) => t.name), ...repeats.map((r) => r.name)];
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) errors.push(`"${name}" is both a text and a repeat`);
  return { texts, repeats, images, contacts: [...contacts], errors };
}

function contactAttr(value: string, contacts: Set<ContactKind>, errors: string[]): void {
  if ((CONTACT_KINDS as readonly string[]).includes(value)) contacts.add(value as ContactKind);
  else errors.push(`data-contact="${value}" is not one of ${CONTACT_KINDS.join(', ')}`);
}

const ImageChoice = z.object({
  photo: z.string().optional().describe("One of the owner's photo files, when one fits this slot."),
  scene: z.string().max(400).optional().describe('When no owner photo fits: the photo to make, described in English (subject, setting, light, framing). No text, signs, logos, labels, menus or storefronts.'),
  alt: z.string().max(140).describe("What the photo shows, in the site's language."),
});
export type ImageChoice = z.infer<typeof ImageChoice>;

/** Haiku overshoots short limits even when told again; a little over still fits most designs, a lot over doesn't. */
export const hardLimit = (max: number) => Math.ceil(max * 1.5) + 10;

const slotText = (slot: TextSlot) => {
  const text = z.string().trim().max(hardLimit(slot.max)).describe(`At most ${slot.max} characters. The template's example: "${slot.sample.slice(0, 160)}"`);
  return slot.optional ? text.optional() : text.min(1);
};

/** The fill_page tool's input: the words for every slot, photos for the image slots, and the search-engine title and description. */
export function fillSchema(manifest: Manifest) {
  return z.object({
    texts: z.object(Object.fromEntries(manifest.texts.map((s) => [s.name, slotText(s)]))),
    lists: z.object(
      Object.fromEntries(
        manifest.repeats.map((r) => [
          r.name,
          z
            .array(z.object(Object.fromEntries(r.fields.map((f) => [f.name, slotText(f)]))))
            .min(r.min)
            .max(r.max)
            .describe(`${r.min} to ${r.max} items.`),
        ]),
      ),
    ),
    images: z.object(Object.fromEntries(manifest.images.map((i) => [i.name, ImageChoice.describe(`A ${i.aspect} photo.`)]))),
    seo: z.object({
      title: z.string().trim().min(5).max(hardLimit(60)).describe('The page title for search engines: the business name and what it does, in the site language. At most 60 characters.'),
      description: z.string().trim().min(20).max(hardLimit(155)).describe('The search result description, in the site language. At most 155 characters.'),
    }),
  });
}

export type Fill = z.infer<ReturnType<typeof fillSchema>>;
/** A stored fill: what fill_page returned, whatever the template. */
export const StoredFill = z.object({
  texts: z.record(z.string(), z.string().optional()),
  lists: z.record(z.string(), z.array(z.record(z.string(), z.string().optional()))),
  /** `file`: the photo the slot got (an owner's, or one made from the scene), so a redesign can keep it. */
  images: z.record(z.string(), ImageChoice.extend({ file: z.string().optional() })),
  seo: z.object({ title: z.string(), description: z.string() }),
});
export type StoredFill = z.infer<typeof StoredFill>;

export interface FillContext {
  answers: Pick<Answers, 'businessName' | 'about' | 'contact' | 'lang' | 'goal'>;
  media: Pick<Media, 'logo' | 'photos'>;
  /** The photo for each image slot (`assets/…`): the owner's, or one made for it. Missing: the template's fallback stays. */
  photos: Record<string, string>;
}

const digits = (s: string) => s.replace(/\D/g, '');

function contactLink(kind: ContactKind, contact: Contact): { href: string; label: string } | undefined {
  switch (kind) {
    case 'whatsapp':
      return { href: `https://wa.me/${digits(contact.whatsapp)}`, label: nationalNumber(contact.whatsapp) };
    case 'phone': {
      const number = contact.phone ?? contact.whatsapp;
      return { href: `tel:+${digits(number)}`, label: nationalNumber(number) };
    }
    case 'email':
      return contact.email ? { href: `mailto:${contact.email}`, label: contact.email } : undefined;
    case 'instagram':
      return contact.instagram ? { href: `https://www.instagram.com/${contact.instagram}`, label: `@${contact.instagram}` } : undefined;
    case 'facebook':
      return contact.facebook ? { href: `https://www.facebook.com/${contact.facebook}`, label: `facebook.com/${contact.facebook}` } : undefined;
    case 'maps':
      return contact.address ? { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contact.address)}`, label: contact.address } : undefined;
  }
}

const GOAL_OF: Record<PageGoal, (typeof GOAL_BUTTONS)[number] | undefined> = { info: undefined, whatsapp: 'whatsapp', call: 'call', visit: 'visit', book: 'book' };
const TEMPLATE_ATTRS = ['data-text', 'data-max', 'data-optional', 'data-repeat', 'data-min', 'data-image', 'data-aspect', 'data-contact', 'data-contact-label', 'data-if', 'data-goal'];

function remove(node: ChildNode): void {
  const siblings = node.parent?.children;
  if (siblings) siblings.splice(siblings.indexOf(node), 1);
}
function setText(el: Element, text: string): void {
  const node = new Text(text);
  node.parent = el;
  el.children = [node];
}
function fragment(html: string, parent: Element): ChildNode[] {
  const nodes = parseDocument(html).children as ChildNode[];
  for (const node of nodes) node.parent = parent;
  return nodes;
}
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const jsonForScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

/**
 * The finished page: the template with the fill's words, the photos, the owner's contact details and the head.
 * Pure; the result still goes through checkPage like any page.
 */
export function fillTemplate(template: string, fill: StoredFill, { answers, media, photos }: FillContext): string {
  const dom: Document = parseDocument(template, { lowerCaseAttributeNames: true });
  const { contact } = answers;
  const filled = new Set<string>();

  const textFor = (name: string, values: Record<string, string | undefined>): string | undefined => {
    if (name === 'business_name') return answers.businessName;
    if (name === 'address') return contact.address;
    return values[name]?.trim() || undefined;
  };
  const fillTexts = (root: AnyNode, values: Record<string, string | undefined>) => {
    const doomed: Element[] = [];
    walk(root, (el) => {
      const name = el.attribs['data-text'];
      if (name === undefined) return;
      const text = textFor(name, values);
      delete el.attribs['data-text']; // filled once: a list item's fields are not the page's
      if (text) {
        setText(el, text);
        filled.add(name);
      } else doomed.push(el);
      return false;
    });
    doomed.forEach(remove);
  };

  // Lists: the first item is the pattern; the template's other sample items go.
  const lists = new Map<string, Element[]>();
  walk(dom, (el) => {
    const name = el.attribs['data-repeat'];
    if (name === undefined) return;
    lists.set(name, [...(lists.get(name) ?? []), el]);
    return false;
  });
  for (const [name, items] of lists) {
    const [first] = items;
    const parent = first!.parent as ParentNode;
    const at = parent.children.indexOf(first!);
    const pattern = render(first!, { encodeEntities: 'utf8' });
    items.forEach(remove);
    const entries = fill.lists[name] ?? [];
    if (entries.length > 0) filled.add(name);
    const clones = entries.map((entry) => {
      const [clone] = parseDocument(pattern, { lowerCaseAttributeNames: true }).children as Element[];
      fillTexts(clone!, entry);
      clone!.parent = parent as Element;
      return clone!;
    });
    parent.children.splice(at, 0, ...clones);
  }
  fillTexts(dom, fill.texts);

  const doomed: Element[] = [];
  walk(dom, (el) => {
    const a = el.attribs;
    if (a['data-image'] !== undefined) {
      const name = a['data-image'];
      const src = name === 'logo' ? media.logo : photos[name];
      if (src) {
        const alt = name === 'logo' ? answers.businessName : (fill.images[name]?.alt ?? '');
        el.children = fragment(`<img src="${attr(src)}" alt="${attr(alt)}" loading="${name === 'logo' ? 'eager' : 'lazy'}" style="width:100%;height:100%;object-fit:${name === 'logo' ? 'contain' : 'cover'};display:block">`, el);
        filled.add(name);
      } else if (name === 'logo') doomed.push(el);
      return false;
    }
    if (a['data-contact'] !== undefined) {
      const link = contactLink(a['data-contact'] as ContactKind, contact);
      if (!link) {
        doomed.push(el);
        return false;
      }
      el.attribs.href = link.href;
      if (/^https?:/.test(link.href)) Object.assign(el.attribs, { target: '_blank', rel: 'noopener' });
      if ('data-contact-label' in a) setText(el, link.label);
      filled.add(a['data-contact']);
    }
  });
  doomed.forEach(remove);

  // data-if: after filling, so an empty slot or a missing contact detail takes its section with it.
  const present = (key: string) => filled.has(key) || ((CONTACT_KINDS as readonly string[]).includes(key) && contactLink(key as ContactKind, contact) !== undefined);
  const unwanted: Element[] = [];
  walk(dom, (el) => {
    const key = el.attribs['data-if'];
    if (key !== undefined && !present(key)) {
      unwanted.push(el);
      return false;
    }
  });
  unwanted.forEach(remove);

  // Main buttons: the one for the owner's goal, else the first; per parent.
  const goal = answers.goal && GOAL_OF[answers.goal];
  const groups = new Map<ParentNode, Element[]>();
  walk(dom, (el) => {
    if (el.attribs['data-goal'] !== undefined && el.parent) groups.set(el.parent, [...(groups.get(el.parent) ?? []), el]);
  });
  for (const buttons of groups.values()) {
    const keep = buttons.find((b) => b.attribs['data-goal'] === goal) ?? buttons[0];
    buttons.filter((b) => b !== keep).forEach(remove);
  }

  walk(dom, (el) => {
    for (const name of TEMPLATE_ATTRS) delete el.attribs[name];
  });
  writeHead(dom, fill, answers);
  return `<!doctype html>\n${render(dom.children.filter(isElement), { encodeEntities: 'utf8' })}\n`;
}

/** The head our code owns: language, title, description, Open Graph, and the LocalBusiness data. */
function writeHead(dom: Document, fill: StoredFill, answers: FillContext['answers']): void {
  const htmlEl = dom.children.find((n): n is Element => isElement(n) && n.name === 'html');
  const head = htmlEl?.children.find((n): n is Element => isElement(n) && n.name === 'head');
  if (!htmlEl || !head) return;
  htmlEl.attribs.lang = answers.lang === 'pt' ? 'pt-BR' : 'es';
  head.children = head.children.filter((n) => {
    if (!isElement(n)) return true;
    if (n.name === 'title') return false;
    if (n.name === 'meta' && (n.attribs.name === 'description' || n.attribs.property?.startsWith('og:'))) return false;
    if (n.name === 'script' && /ld\+json/i.test(n.attribs.type ?? '')) return false;
    return true;
  });
  const { contact } = answers;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: answers.businessName,
    description: fill.seo.description,
    telephone: `+${digits(contact.phone ?? contact.whatsapp)}`,
    ...(contact.email && { email: contact.email }),
    ...(contact.address && { address: contact.address }),
    ...((contact.instagram || contact.facebook) && {
      sameAs: [contact.instagram && `https://www.instagram.com/${contact.instagram}`, contact.facebook && `https://www.facebook.com/${contact.facebook}`].filter(Boolean),
    }),
  };
  head.children.push(
    ...fragment(
      [
        `<title>${attr(fill.seo.title)}</title>`,
        `<meta name="description" content="${attr(fill.seo.description)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${attr(fill.seo.title)}">`,
        `<meta property="og:description" content="${attr(fill.seo.description)}">`,
        `<script type="application/ld+json">${jsonForScript(data)}</script>`,
      ].join('\n'),
      head,
    ),
  );
}
