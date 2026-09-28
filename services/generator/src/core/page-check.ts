import render from 'dom-serializer';
import { Element, Text, type AnyNode, type Document } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { Contact } from './content';
import { html as h } from './html';
import { strings } from './i18n';
import { checkTexts, type Violation } from './policy';

/**
 * Checks on a page Opus wrote freely. What can be repaired is repaired (a link that isn't the owner's becomes
 * "#", an outside image or script is removed); what can't (a redirect, a phone number or email the owner never
 * gave, text the content policy rejects) is a violation, and the page is not used. The sites CSP is the second
 * line: scripts cannot fetch or send anything, images load only from the site itself.
 */

/** Where page scripts, stylesheets, and fonts may come from. The sites CSP lists the same hosts. */
export const PAGE_SCRIPT_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];
export const PAGE_STYLE_HOSTS = ['fonts.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];
export const PAGE_FONT_HOSTS = ['fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];

/** The Google map embed forms a page may frame. */
const MAP_EMBED = /^https:\/\/(maps\.google\.com|www\.google\.com)\/maps(\/embed)?\b[^"<>]*$/;

export interface PageCheckResult {
  /** The repaired, finished page (footer and overflow guard added). */
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
 * The contact details a page may show: the owner's contact answers, and every phone number and email the owner
 * wrote anywhere else (a second branch, an orders email). What the model invents is none of these.
 */
interface Known {
  contact: Contact;
  numbers: string[];
  emails: string[];
}

function knownDetails(contact: Contact, ownerText: string): Known {
  const written = [...ownerText.matchAll(PHONE_LIKE)].map(([n]) => digits(n)).filter((d) => d.length >= 7);
  const numbers = [contact.whatsapp, contact.phone, ...written].filter((n): n is string => !!n);
  const emails = [contact.email, ...[...ownerText.matchAll(EMAIL_LIKE)].map(([e]) => e)].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  return { contact, numbers, emails };
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
  return false;
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

export interface PageCheckOptions {
  contact: Contact;
  /** Everything else the owner wrote (description, answers, edit requests): its numbers and emails are the owner's too. */
  ownerText?: string;
  businessName: string;
  lang: 'es' | 'pt';
  reportUrl: string;
  privacyUrl: string;
}

export function checkPage(page: string, { contact, ownerText = '', businessName, lang, reportUrl, privacyUrl }: PageCheckOptions): PageCheckResult {
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
      for (const detail of redirects(code, known)) violations.push({ code: 'forbidden-url', detail });
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
  violations.push(...checkTexts(texts, { businessName, headlines }));
  for (const text of texts) {
    for (const [number] of text.matchAll(PHONE_LIKE)) {
      // Phone-shaped: 9+ digits. Year ranges ("2019 – 2024") and prices are shorter or look different.
      if (digits(number).length < 9 || /^(19|20)\d\d\D+(19|20)\d\d$/.test(number.trim()) || ownersNumber(number, known)) continue;
      violations.push({ code: 'forbidden-url', detail: `a phone number the owner did not give (${number.trim()})` });
    }
    for (const [email] of text.matchAll(EMAIL_LIKE)) if (!known.emails.includes(email.toLowerCase())) violations.push({ code: 'forbidden-url', detail: `an email the owner did not give (${email})` });
  }

  // Finish: no sideways scrolling on phones, and the platform footer.
  const htmlEl = dom.children.find((n): n is Element => isElement(n) && n.name === 'html');
  const head = htmlEl?.children.find((n): n is Element => isElement(n) && n.name === 'head');
  const body = htmlEl?.children.find((n): n is Element => isElement(n) && n.name === 'body');
  if (!head || !body) violations.push({ code: 'forbidden-element', detail: 'not a complete HTML document' });
  else {
    const guard = parseDocument('<style>html,body{overflow-x:clip}</style>').children[0]!;
    guard.parent = head;
    head.children.push(guard);
    const t = strings(lang);
    const footer = parseDocument(
      h`<footer style="padding:1.25rem;font:13px/1.5 system-ui,sans-serif;text-align:center;opacity:.75;background:inherit">${t.madeWith} · <a href="${reportUrl}" style="color:inherit">${t.report}</a> · <a href="${privacyUrl}" style="color:inherit">${t.privacy}</a></footer>`.value,
    ).children[0]!;
    footer.parent = body;
    body.children.push(footer);
  }

  return { html: `<!doctype html>\n${render(dom.children.filter(isElement), { encodeEntities: 'utf8' })}\n`, violations: dedupe(violations), repairs: [...new Set(repairs)], texts };
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => (seen.has(v.detail) ? false : (seen.add(v.detail), true)));
}

/**
 * The contact details the page writer sees: phone numbers are stand-ins of the same length and country code
 * (the privacy page promises the models never get them). replaceContact swaps the real ones back in.
 */
export function maskContact(contact: Contact): Contact {
  const mask = (n: string | undefined, fill: string) => n && (n.slice(0, 2) + fill.repeat(2)).slice(0, n.length);
  return { ...contact, whatsapp: mask(contact.whatsapp, '3125550147')!, phone: mask(contact.phone, '2045550188') };
}

/**
 * A contact change on a written page, with no model call: every place the old detail appears (links, scripts,
 * text, in any formatting) gets the new one.
 */
export function replaceContact(page: string, before: Contact, after: Contact): string {
  let out = page;
  const numberPattern = (n: string) => new RegExp(n.split('').map((d) => d.replace(/\d/, '$&')).join('[\\s().-]*'), 'g');
  for (const field of ['whatsapp', 'phone'] as const) {
    const old = before[field];
    const next = after[field];
    if (!old || !next || old === next) continue;
    out = out.replace(numberPattern(old), next); // digits in links and scripts, and formatted numbers in text
    const local = old.replace(/^(1|2\d|3\d|4\d|5[1-8]|59\d|6\d|7|8\d|9\d)/, ''); // the number without its country code
    if (local.length >= 7 && local !== old) out = out.replace(numberPattern(local), next.slice(next.length - local.length));
  }
  for (const field of ['email', 'address', 'instagram', 'facebook'] as const) {
    const old = before[field];
    const next = after[field];
    if (old && next && old !== next) out = out.split(old).join(next);
  }
  return out;
}
