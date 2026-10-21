import render from 'dom-serializer';
import { Element, Text, type AnyNode, type Document } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { Contact } from './content';
import { escapeHtml, html as h } from './html';
import { countryOf, nationalNumber } from './phones';
import { checkTexts, type Violation } from './policy';

/**
 * Checks on a page Opus wrote freely. What can be repaired is repaired (a link that isn't the owner's contact or an
 * address they wrote becomes "#", an outside image or script is removed); what can't (a redirect, a phone number or
 * email the owner never gave, text the content policy rejects) is a violation, and the page is not used. The sites
 * CSP is the second line: scripts cannot fetch or send anything, images load only from the site itself.
 */

/** Where page scripts, stylesheets, and fonts may come from. The sites CSP lists the same hosts. */
export const PAGE_SCRIPT_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];
export const PAGE_STYLE_HOSTS = ['fonts.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];
export const PAGE_FONT_HOSTS = ['fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];

/** The Google map embed forms a page may frame. */
const MAP_EMBED = /^https:\/\/(maps\.google\.com|www\.google\.com)\/maps(\/embed)?\b[^"<>]*$/;

export interface PageCheckResult {
  /** The repaired, finished page (overflow guard added). */
  html: string;
  /** Problems that repairs cannot fix: the page must not be used. */
  violations: Violation[];
  /** What was repaired, for the logs. */
  repairs: string[];
  /** Everything a visitor can read, for the output guardrail. */
  texts: string[];
}

const isElement = (node: AnyNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';
const hostOf = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};
const digits = (s: string) => s.replace(/\D/g, '');

const PHONE_LIKE = /[+(]?\d[\d\s().-]{6,}\d/g;
const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * The contact details a page may show: the owner's contact answers, and every phone number, email and web address
 * the owner wrote anywhere else (a second branch, an orders email, their shop). What the model invents is none of these.
 */
interface Known {
  contact: Contact;
  numbers: string[];
  emails: string[];
  /** Hosts of the web addresses the owner wrote (`https://…` or `www.…`), without `www.`. */
  hosts: Set<string>;
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s"'<>()[\]{}]+/gi;
/** Link shorteners: they hide where a link goes. */
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'bl.ink', 's.id', 'v.gd', 't.ly', 'lnkd.in', 'shorte.st', 'adf.ly']);
/** Direct downloads a page should not hand out. */
const DOWNLOAD = /\.(?:exe|msi|apk|dmg|pkg|bat|cmd|scr|jar|zip|rar|7z)$/i;
const bareHost = (host: string) => host.replace(/^www\./, '');

/**
 * A web address the owner wrote, by host: https only, a real name (no IP address, no lookalike `xn--` label), no
 * link shortener, no direct download.
 */
function ownersLink(href: string, known: Known): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host.split('.').some((label) => label.startsWith('xn--'))) return false;
  if (SHORTENERS.has(bareHost(host)) || DOWNLOAD.test(url.pathname)) return false;
  return known.hosts.has(bareHost(host));
}

function knownDetails(contact: Contact, ownerText: string): Known {
  const written = [...ownerText.matchAll(PHONE_LIKE)].map(([n]) => digits(n)).filter((d) => d.length >= 7);
  const numbers = [contact.whatsapp, contact.phone, ...written].filter((n): n is string => !!n);
  const emails = [contact.email, ...[...ownerText.matchAll(EMAIL_LIKE)].map(([e]) => e)].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const hosts = new Set(
    [...ownerText.matchAll(URL_LIKE)].flatMap(([u]) => {
      const host = hostOf(/^www\./i.test(u) ? `https://${u}` : u);
      return host ? [bareHost(host.replace(/:\d+$/, ''))] : [];
    }),
  );
  return { contact, numbers, emails, hosts };
}

/** A number is the owner's when its digits end with a known number (with or without the country code). */
function ownersNumber(found: string, known: Known): boolean {
  const d = digits(found);
  if (d.length < 7) return true;
  return known.numbers.some((n) => n.endsWith(d) || d.endsWith(n));
}

function linkAllowed(href: string, known: Known): boolean {
  const { contact } = known;
  if (href.startsWith('#') || href === '') return true;
  if (/^tel:/i.test(href)) return ownersNumber(href, known);
  if (/^mailto:/i.test(href)) return known.emails.includes(href.slice(7).split('?')[0]!.toLowerCase());
  const host = hostOf(href);
  if (!host || !/^https?:/i.test(href)) return false;
  if (host === 'wa.me' || host.endsWith('whatsapp.com')) {
    const phone = host === 'wa.me' ? new URL(href).pathname.slice(1) : (new URL(href).searchParams.get('phone') ?? '');
    return digits(phone).length >= 7 && ownersNumber(phone, known);
  }
  if (host === 'maps.google.com' || host === 'maps.app.goo.gl' || ((host === 'www.google.com' || host === 'google.com') && new URL(href).pathname.startsWith('/maps')) || host === 'goo.gl') return true;
  if (host.endsWith('instagram.com')) return !!contact.instagram && new URL(href).pathname.replace(/\/+$/, '').toLowerCase() === `/${contact.instagram.toLowerCase()}`;
  if (host.endsWith('facebook.com')) return !!contact.facebook && new URL(href).pathname.replace(/\/+$/, '').toLowerCase() === `/${contact.facebook.toLowerCase()}`;
  return ownersLink(href, known);
}

/** Scripts that send the visitor somewhere else. Links opened by a script must be the owner's WhatsApp or a map. */
function redirects(code: string, known: Known): string[] {
  const found: string[] = [];
  if (/\b(?:window\.|document\.|top\.)?location\s*(?:\.href\s*)?=(?!=)|location\.(?:replace|assign)\s*\(/.test(code)) found.push('a script that changes location');
  for (const [, url] of code.matchAll(/["'`](https?:\/\/[^"'`\s$]+)/g)) {
    if (!url) continue;
    const host = hostOf(url);
    if (!host) continue;
    const allowedHost = host === 'wa.me' || host.endsWith('whatsapp.com') || host.endsWith('google.com') || PAGE_SCRIPT_HOSTS.includes(host) || PAGE_STYLE_HOSTS.includes(host) || host === 'www.w3.org';
    if (!allowedHost) found.push(`a script URL to ${host}`);
    if (host === 'wa.me' && /^https?:\/\/wa\.me\/\d/.test(url) && !linkAllowed(url, known)) found.push('a script WhatsApp link to another number');
  }
  // Phone numbers a script shows or dials: a quoted "+57 300 …" or a tel: link. Number arrays and timestamps are not.
  for (const [, match] of code.matchAll(/(?:["'`]|tel:)(\+?\d[\d\s().-]{7,}\d)/g)) {
    if (match && /[+\s().-]|^\d{9,13}$/.test(match) && digits(match).length >= 9 && !ownersNumber(match, known)) found.push(`a phone number in a script (${match})`);
  }
  return found;
}

/** What's wrong in a structured-data block (JSON-LD): links that aren't the owner's, contact details the owner never gave. */
function dataProblems(data: string, known: Known): string[] {
  const found: string[] = [];
  for (const [, url] of data.matchAll(/"(https?:\/\/[^"\s]+)"/g)) {
    const host = hostOf(url!);
    if (host !== 'schema.org' && !linkAllowed(url!, known)) found.push(`a link to ${url!.slice(0, 60)}`);
  }
  for (const [number] of data.matchAll(PHONE_LIKE)) if (digits(number).length >= 9 && !ownersNumber(number, known)) found.push(`a phone number the owner did not give (${number.trim()})`);
  for (const [email] of data.matchAll(EMAIL_LIKE)) if (!known.emails.includes(email.toLowerCase())) found.push(`an email the owner did not give (${email})`);
  return found;
}

export interface PageCheckOptions {
  contact: Contact;
  /** Everything else the owner wrote (description, answers, edit requests): its numbers and emails are the owner's too. */
  ownerText?: string;
  businessName: string;
  lang: 'es' | 'pt';
  /** The site's image files (`assets/…`). Set: an image of the page's own that is not one of them is removed. */
  assets?: string[];
}

/** Globals a page script cannot declare at its top level (the browser refuses the whole script). */
const FIXED_GLOBAL = /(^|[;\n{}])\s*(?:const|let|class)\s+(?:top|window|document|location)\b/;

/**
 * Runs before the page's own scripts. When one of them throws (a syntax error included), every element still fully
 * transparent after load is made visible: a broken script must not leave the page blank (fade-ins on scroll).
 */
const REVEAL_ON_ERROR =
  "(function(){var failed=false;addEventListener('error',function(e){if(!(e.target instanceof Element))failed=true},true);addEventListener('load',function(){setTimeout(function(){if(!failed)return;document.querySelectorAll('body *').forEach(function(el){var s=getComputedStyle(el);if(s.opacity==='0'&&s.visibility!=='hidden'){el.style.opacity='1';el.style.transform='none'}})},600)})})();";

export function checkPage(page: string, { contact, ownerText = '', businessName, lang, assets }: PageCheckOptions): PageCheckResult {
  const known = knownDetails(contact, ownerText);
  const violations: Violation[] = [];
  const repairs: string[] = [];
  const texts: string[] = [];
  const headlines: string[] = [];
  const dom: Document = parseDocument(page, { lowerCaseAttributeNames: true });
  const doomed: AnyNode[] = [];

  const visit = (node: AnyNode) => {
    if (node.type === 'text') {
      const parent = node.parent as Element | null;
      if (parent && isElement(parent) && ['script', 'style', 'noscript', 'template'].includes(parent.name)) return;
      const text = (node as Text).data.replace(/\s+/g, ' ').trim();
      if (text) texts.push(text);
      return;
    }
    if (!isElement(node)) return;
    const el = node;
    const tag = el.name.toLowerCase();
    const attr = (name: string) => el.attribs[name];

    if (['base', 'object', 'embed', 'frame', 'frameset', 'portal', 'applet'].includes(tag)) {
      doomed.push(el);
      repairs.push(`removed <${tag}>`);
      return;
    }
    if (tag === 'meta' && /refresh/i.test(attr('http-equiv') ?? '')) {
      violations.push({ code: 'forbidden-element', detail: 'meta refresh' });
      return;
    }
    if (tag === 'iframe') {
      if (!MAP_EMBED.test(attr('src') ?? '')) {
        doomed.push(el);
        repairs.push('removed an iframe that is not a Google map');
        return;
      }
    }
    for (const name of Object.keys(el.attribs)) if (name === 'srcdoc' || name === 'formaction') delete el.attribs[name];
    if (tag === 'a' || tag === 'area') {
      const href = attr('href')?.trim();
      if (href !== undefined && !linkAllowed(href, known)) {
        el.attribs.href = '#';
        repairs.push(`link to ${href.slice(0, 60)} → #`);
      }
    }
    if (tag === 'form') {
      if (attr('action') !== undefined || attr('method') !== undefined) repairs.push('removed a form action');
      delete el.attribs.action;
      delete el.attribs.method;
    }
    if (tag === 'script') {
      const src = attr('src');
      if (src !== undefined && !PAGE_SCRIPT_HOSTS.includes(hostOf(src) ?? '')) {
        doomed.push(el);
        repairs.push(`removed a script from ${hostOf(src) ?? src.slice(0, 40)}`);
        return;
      }
      const code = el.children.map((c) => ('data' in c ? c.data : '')).join('');
      if (/^application\/(?:ld\+)?json$/i.test(attr('type')?.trim() ?? '')) {
        // Data for search engines, never run: no redirect check, but its links and contact details must be the
        // owner's, or the block goes (the page is the same without it).
        const problems = dataProblems(code, known);
        if (problems.length) {
          doomed.push(el);
          repairs.push(`removed structured data (${problems.join('; ')})`);
        }
        return;
      }
      for (const detail of redirects(code, known)) violations.push({ code: 'forbidden-url', detail });
      // A classic script that declares a browser's fixed global (`const top = …`) is refused whole by the browser, and
      // whatever it shows (fade-ins, menus) never appears. In a block, its declarations are its own.
      const text = el.children.find((c): c is Text => c.type === 'text');
      if (text && !/module/i.test(attr('type') ?? '') && FIXED_GLOBAL.test(code)) {
        text.data = `{\n${text.data}\n}`;
        repairs.push('wrapped a script that redeclared a browser global');
      }
      return;
    }
    if (tag === 'link') {
      const host = hostOf(attr('href') ?? '');
      const rel = (attr('rel') ?? '').toLowerCase();
      if (!host || ![...PAGE_STYLE_HOSTS, ...PAGE_FONT_HOSTS, ...PAGE_SCRIPT_HOSTS].includes(host) || !/stylesheet|preconnect|preload|dns-prefetch/.test(rel)) {
        if (!(rel.includes('icon') && (attr('href') ?? '').startsWith('data:'))) {
          doomed.push(el);
          repairs.push(`removed <link rel="${rel}">`);
          return;
        }
      }
    }
    if (tag === 'img' || tag === 'source') {
      for (const name of ['src', 'srcset'] as const) {
        const value = attr(name);
        if (value === undefined) continue;
        const outside = value.split(',').some((part) => /^\s*(https?:)?\/\//i.test(part));
        if (outside) {
          doomed.push(el);
          repairs.push(`removed an outside image`);
          return;
        }
        // A photo the owner took out, or a file name the writer made up: it would show as a broken image.
        const missing = assets && value.split(',').map((part) => part.trim().split(/\s+/)[0]!.replace(/^\.\//, '')).find((url) => url.startsWith('assets/') && !assets.includes(url));
        if (missing) {
          doomed.push(el);
          repairs.push(`removed an image that is not the site's (${missing.slice(0, 60)})`);
          return;
        }
      }
    }
    for (const name of ['alt', 'title', 'aria-label', 'placeholder']) if (attr(name)) texts.push(attr(name)!);
    if (tag === 'title' || tag === 'h1') headlines.push(el.children.map((c) => ('data' in c ? c.data : '')).join(' '));
    el.children.forEach(visit);
  };
  dom.children.forEach(visit);
  for (const node of doomed) {
    const siblings = node.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(node), 1);
  }

  // The text a visitor reads: the content policy, and contact details the owner never gave.
  violations.push(...checkTexts(texts, { businessName, headlines }, known.numbers));
  for (const text of texts) {
    for (const [number] of text.matchAll(PHONE_LIKE)) {
      // Phone-shaped: 9+ digits. Year ranges ("2019 – 2024") and prices are shorter or look different.
      if (digits(number).length < 9 || /^(19|20)\d\d\D+(19|20)\d\d$/.test(number.trim()) || ownersNumber(number, known)) continue;
      violations.push({ code: 'forbidden-url', detail: `a phone number the owner did not give (${number.trim()})` });
    }
    for (const [email] of text.matchAll(EMAIL_LIKE)) if (!known.emails.includes(email.toLowerCase())) violations.push({ code: 'forbidden-url', detail: `an email the owner did not give (${email})` });
  }

  // Finish: no sideways scrolling on phones.
  const htmlEl = dom.children.find((n): n is Element => isElement(n) && n.name === 'html');
  const head = htmlEl?.children.find((n): n is Element => isElement(n) && n.name === 'head');
  const body = htmlEl?.children.find((n): n is Element => isElement(n) && n.name === 'body');
  if (!head || !body) violations.push({ code: 'forbidden-element', detail: 'not a complete HTML document' });
  else {
    const guard = parseDocument('<style>html,body{overflow-x:clip}</style>').children[0]!;
    guard.parent = head;
    head.children.push(guard);
    // First in the head: if a page script fails, content it was going to fade in is shown anyway once the page loads.
    const reveal = parseDocument(`<script>${REVEAL_ON_ERROR}</script>`).children[0]!;
    reveal.parent = head;
    head.children.unshift(reveal);
  }

  return { html: `<!doctype html>\n${render(dom.children.filter(isElement), { encodeEntities: 'utf8' })}\n`, violations: dedupe(violations), repairs: [...new Set(repairs)], texts };
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => (seen.has(v.detail) ? false : (seen.add(v.detail), true)));
}

/** The ways a number can be written without its country code, longest first (an Argentine mobile with or without the 9). */
export function localForms(n: string): string[] {
  const country = countryOf(n);
  if (!country) {
    const local = n.replace(/^(1|2\d|3\d|4\d|5[1-8]|59\d|6\d|7|8\d|9\d)/, '');
    return local !== n ? [local] : [];
  }
  const local = n.slice(country.dial.length);
  return country.iso === 'AR' && local.startsWith('9') ? [local, local.slice(1)] : [local];
}

/**
 * A phone number in any formatting: its digits with spaces, dots, dashes, or parentheses between them, including
 * the non-breaking kinds the page writer uses so a number doesn't wrap (as characters or as HTML entities).
 */
const NUMBER_GAP = '(?:[\\s().\\u2010-\\u2015\\u2212-]|&nbsp;|&#160;|&#x0*a0;|&#8209;|&#x0*2011;)*';
export const numberPattern = (n: string) => new RegExp(n.split('').join(NUMBER_GAP), 'gi');

/**
 * The owner's numbers in the text a visitor reads, written the way people in the business's country write them
 * (`nationalNumber`): "+54 9 11 2345 6789", "9 11 2345 6789" or "1123456789" becomes "11 2345-6789", also after a
 * contact change kept the old number's spacing. Links, scripts and attributes keep the international number. Edits
 * the source in place, so the rest of the page stays as written.
 */
export function nationalNumbers(page: string, contact: Contact): string {
  const forms = [contact.whatsapp, contact.phone].flatMap((n) => {
    if (!n || !countryOf(n)) return [];
    const ways = [`(?:\\(?(?:\\+|00)${NUMBER_GAP})?${numberPattern(n).source}`, ...localForms(n).filter((f) => f.length >= 7).map((f) => numberPattern(f).source)];
    return [{ pattern: new RegExp(`(?<![\\d+])(?:${ways.join('|')})(?!\\d)`, 'gi'), national: escapeHtml(nationalNumber(n)) }];
  });
  if (forms.length === 0) return page;
  const dom = parseDocument(page, { lowerCaseAttributeNames: true, withStartIndices: true, withEndIndices: true });
  const spans: { start: number; end: number }[] = [];
  const visit = (node: AnyNode) => {
    if (node.type === 'text') {
      if (node.startIndex !== null && node.endIndex !== null) spans.push({ start: node.startIndex, end: node.endIndex + 1 });
      return;
    }
    if (!isElement(node) || ['script', 'style', 'noscript', 'template'].includes(node.name)) return;
    node.children.forEach(visit);
  };
  dom.children.forEach(visit);
  let out = page;
  for (const { start, end } of spans.reverse()) {
    const text = out.slice(start, end);
    const next = forms.reduce((t, { pattern, national }) => t.replace(pattern, national), text);
    if (next !== text) out = out.slice(0, start) + next + out.slice(end);
  }
  return out;
}

/** Puts `next`'s digits into a matched number, keeping the page's formatting when the two numbers have the same length. */
const swapDigits = (next: string) => (match: string) => {
  // Digits inside an entity (&#160;) are not the number's.
  const parts = match.split(/(&#?\w+;)/);
  if (parts.filter((_, k) => k % 2 === 0).join('').replace(/\D/g, '').length !== next.length) return next;
  let i = 0;
  return parts.map((part, k) => (k % 2 === 1 ? part : part.replace(/\d/g, () => next[i++]!))).join('');
};

const ACCENTED: Record<string, string> = { a: 'aáàâäã', e: 'eéèêë', i: 'iíìîï', o: 'oóòôöõ', u: 'uúùûü', n: 'nñ', c: 'cç' };

/**
 * An address as the page writer may have written it: any capitals and accents, any punctuation, spaces, or line
 * breaks between its words ("av. bolivar 244, pueblo libre" finds "Av. Bolívar 244<br>Pueblo Libre"). Only for
 * addresses of two words or more, so a one-word address doesn't match ordinary text.
 */
export function addressPattern(address: string): RegExp | undefined {
  const words = address.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g);
  if (!words || words.length < 2) return undefined;
  const word = (w: string) => [...w].map((ch) => (ACCENTED[ch] ? `[${ACCENTED[ch]}]` : ch)).join('');
  const between = '(?:[\\s,.;:·•#º°/&-]|&nbsp;|&amp;|<br\\s*/?>)+';
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(word).join(between)}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Whether a text shows one of the owner's contact details (their numbers in any formatting, email, address, social handles). */
export function showsContact(text: string, contact: Contact): boolean {
  for (const field of ['whatsapp', 'phone'] as const) {
    const n = contact[field];
    if (n && [n, ...localForms(n)].some((form) => form.length >= 7 && numberPattern(form).test(text))) return true;
  }
  const lower = text.toLowerCase();
  if ((['email', 'instagram', 'facebook'] as const).some((field) => contact[field] && lower.includes(contact[field]!.toLowerCase()))) return true;
  return !!contact.address && !!addressPattern(contact.address)?.test(text);
}

/** Contact details that changed but aren't on the page after the swap (the page wrote the old one some other way). */
export function contactMissing(page: string, before: Contact, after: Contact): (keyof Contact)[] {
  const fields = ['whatsapp', 'phone', 'email', 'address', 'instagram', 'facebook'] as const;
  return fields.filter((field) => {
    const next = after[field];
    if (!next || next === before[field]) return false;
    if (field === 'whatsapp' || field === 'phone') return !numberPattern(next).test(page) && !localForms(next).some((local) => local.length >= 7 && numberPattern(local).test(page));
    if (field === 'address') return !page.includes(escapeHtml(next)) && !addressPattern(next)?.test(page);
    return !page.toLowerCase().includes(next.toLowerCase());
  });
}

/**
 * A contact change on a written page, with no model call: every place the old detail appears (links, scripts,
 * text, in any formatting) gets the new one.
 */
export function replaceContact(page: string, before: Contact, after: Contact): string {
  let out = page;
  for (const field of ['whatsapp', 'phone'] as const) {
    const old = before[field];
    const next = after[field];
    if (!old || !next || old === next) continue;
    out = out.replace(numberPattern(old), swapDigits(next)); // digits in links and scripts, and formatted numbers in text
    for (const local of localForms(old)) {
      if (local.length >= 7) out = out.replace(numberPattern(local), swapDigits(next.slice(next.length - local.length)));
    }
  }
  for (const field of ['email', 'instagram', 'facebook'] as const) {
    const old = before[field];
    const next = after[field];
    if (old && next && old !== next) out = out.split(old).join(next);
  }
  const { address: oldAddress } = before;
  const { address: newAddress } = after;
  if (oldAddress && newAddress && oldAddress !== newAddress) {
    out = out.split(escapeHtml(oldAddress)).join(escapeHtml(newAddress));
    const loose = addressPattern(oldAddress);
    if (loose) out = out.replace(loose, escapeHtml(newAddress));
  }
  return out;
}
