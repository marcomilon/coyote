import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { findBrand, normalizeForMatch } from './brands';
import { FONT_ORIGINS, fromOrigins, isHttpsUrl, SCRIPT_ORIGINS, STYLE_ORIGINS } from './cdn';

export interface Violation {
  code:
    | 'brand'
    | 'scam-phrase'
    | 'credential-request'
    | 'card-number'
    | 'forbidden-element'
    | 'forbidden-attribute'
    | 'forbidden-url'
    | 'forbidden-form'
    | 'forbidden-css'
    | 'sanitizer';
  detail: string;
}

/** Any violation rejects the site. Details are for our logs, never shown to the user. */
export class PolicyRejection extends Error {
  constructor(readonly violations: Violation[]) {
    super(`Policy rejection: ${violations.map((v) => `${v.code} (${v.detail})`).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|xyz|top|click|link|site|online|app|io|co|mx|br|ar|cl|pe|ec|uy|py|bo|ve)(?:\.[a-z]{2})?(?:\/\S*)?/gi;

/** Matched after normalizeForMatch (lowercase, no accents, single spaces). es + pt. */
const SCAM_PHRASES = [
  'verifica tu cuenta', 'verifique su cuenta', 'verifique sua conta', 'verifica tu identidad',
  'actualiza tus datos', 'actualice sus datos', 'atualize seus dados', 'confirme seus dados', 'confirma tus datos',
  'cuenta suspendida', 'cuenta bloqueada', 'cuenta sera suspendida', 'conta suspensa', 'conta bloqueada',
  'acceso restringido', 'desbloquea tu cuenta', 'desbloqueie sua conta',
  'has sido seleccionado', 'voce foi selecionado', 'reclama tu premio', 'resgate seu premio', 'para tu premio', 'ganaste un premio',
  'has ganado', 'voce ganhou', 'seu premio',
  'inicia sesion para continuar', 'faca login para continuar',
];

const CREDENTIAL_NOUNS =
  /\b(pin|nip|otp|cvv|cvc|contrasena|password|senha|clave (?:dinamica|de acceso|bancaria|del cajero|de internet)|token|codigo de (?:verificacion|seguridad|confirmacion)|codigo sms|numero de (?:tarjeta|cartao|cuenta)|datos (?:bancarios|de (?:la|tu) tarjeta)|dados (?:bancarios|do cartao))\b/;
/** Verb stems, so "ingresa", "ingrese", "ingresando" all match. */
const REQUEST_VERBS =
  /\b(ingres|introdu|escrib|envi|mand|digit|confirm|proporcion|compart|insir|insert|captur|teclea)\w*/;

const DIGIT_RUN = /(?:\d[ -]?){13,19}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** A phone number written out in the copy: 8+ digits, with the usual separators. Hours and prices are shorter. */
const PHONE_LIKE = /[+(]*\d[\d\s().-]{6,}\d/g;

/** Removes URLs and phone numbers from one text (a free-text answer). A visible URL can still send people somewhere. */
export function scrubText(text: string): string {
  return text
    .replace(URL_LIKE, '')
    // The page adds the owner's verified contact details itself, so a number in free text goes.
    .replace(PHONE_LIKE, (match) => (match.replace(/\D/g, '').length >= 8 ? '' : match))
    .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Contact details written into the page text instead of through a placeholder: URLs, e-mail addresses, and
 * phone-like numbers (8+ digits; prices after a currency sign do not count). Resolves to what was found.
 */
export function contactInText(text: string): string[] {
  const found = [...(text.match(URL_LIKE) ?? []), ...(text.match(EMAIL_LIKE) ?? [])];
  for (const match of text.matchAll(PHONE_LIKE)) {
    const before = text.slice(Math.max(0, match.index - 3), match.index);
    if (match[0].replace(/\D/g, '').length >= 8 && !/[$€£]\s?$/.test(before)) found.push(match[0]);
  }
  return found;
}

/**
 * Content policy on the text a visitor can read. `named` are the texts where a brand name counts as
 * impersonation (the business name, the title, the h1); every text is checked for scam phrases,
 * credential requests, and card numbers.
 */
export function checkTexts(texts: string[], named: { businessName?: string; headlines?: string[] } = {}): Violation[] {
  const violations: Violation[] = [];

  if (named.businessName) {
    const nameBrand = findBrand(named.businessName, 'name');
    if (nameBrand) violations.push({ code: 'brand', detail: `businessName: ${nameBrand}` });
  }
  for (const headline of named.headlines ?? []) {
    const brand = findBrand(headline, 'copy');
    if (brand) violations.push({ code: 'brand', detail: `headline: ${brand}` });
  }

  for (const text of texts) {
    const normalized = normalizeForMatch(text);
    const phrase = SCAM_PHRASES.find((p) => normalized.includes(p));
    if (phrase) violations.push({ code: 'scam-phrase', detail: phrase });

    for (const sentence of text.split(/[.!?\n]+/)) {
      const s = normalizeForMatch(sentence);
      const noun = CREDENTIAL_NOUNS.exec(s);
      if (noun && REQUEST_VERBS.test(s)) violations.push({ code: 'credential-request', detail: noun[0] });
    }

    for (const run of text.match(DIGIT_RUN) ?? []) {
      const digits = run.replace(/\D/g, '');
      if (digits.length >= 13 && luhn(digits)) violations.push({ code: 'card-number', detail: `${digits.length} digits` });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------------------------
// Filled page: the final check before a page is stored (catches sanitizer and fill.ts bugs)
// ---------------------------------------------------------------------------------------------

export interface HtmlPolicyOptions {
  /** Origins the platform itself links to: the app (report, privacy) and the site's own origin. */
  platformOrigins: string[];
  /** Exact `action` of the contact form. Unset (MVP) = no form allowed at all. */
  contactFormAction?: string;
  /** The owner's WhatsApp number: every wa.me link must point to it. */
  whatsapp?: string;
}

/** The one iframe a page may carry: fill.ts's keyless Google Maps embed. */
export const MAP_EMBED = /^https:\/\/maps\.google\.com\/maps\?q=[^&"<>\s]+&z=16&output=embed$/;

const FORBIDDEN_ELEMENTS = new Set(['iframe', 'frame', 'object', 'embed', 'applet', 'base', 'portal', 'noscript']);
const FORM_FIELD_TYPES = new Set(['text', 'tel', 'email', 'hidden', 'submit']);
const LINK_HOSTS = new Set([
  'wa.me', 'instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com',
  'maps.google.com',
]);
const RESOURCE_ORIGINS = [...STYLE_ORIGINS, ...FONT_ORIGINS, ...SCRIPT_ORIGINS];
const LINK_RELS = new Set(['stylesheet', 'preconnect', 'canonical', 'icon', 'apple-touch-icon']);

const isRelative = (url: string) => /^(?![a-z][a-z0-9+.-]*:|\/\/)/i.test(url) && !url.startsWith('/');

function urlAllowed(url: string, kind: 'link' | 'resource', platformOrigins: string[]): boolean {
  if (url.startsWith('#') || isRelative(url)) return true;
  if (kind === 'resource' && url.startsWith('data:image/svg+xml,')) return true; // the generated favicon
  if (kind === 'link' && /^(tel|mailto):/i.test(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !platformOrigins.includes(parsed.origin)) return false;
  if (platformOrigins.includes(parsed.origin)) return true;
  if (kind === 'resource') return RESOURCE_ORIGINS.includes(parsed.origin);
  if (parsed.host === 'goo.gl') return parsed.pathname.startsWith('/maps');
  return LINK_HOSTS.has(parsed.host);
}

function cssViolations(css: string, where: string): Violation[] {
  const violations: Violation[] = [];
  if (/@import/i.test(css)) violations.push({ code: 'forbidden-css', detail: `${where}: @import` });
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    const target = match[2] ?? '';
    if (!/^data:image\//i.test(target) && !isRelative(target) && !isHttpsUrl(target)) {
      violations.push({ code: 'forbidden-css', detail: `${where}: url(${target.slice(0, 60)})` });
    }
  }
  return violations;
}

export function checkHtml(page: string, options: HtmlPolicyOptions): Violation[] {
  const violations: Violation[] = [];
  const { platformOrigins, contactFormAction, whatsapp } = options;
  let maps = 0;

  const visit = (node: ChildNode, insideContactForm: boolean): void => {
    if (node.type === 'script' || node.type === 'style' || node.type === 'tag') {
      const el = node as Element;
      const tag = el.name.toLowerCase();
      const attr = (name: string) => el.attribs[name];
      let inForm = insideContactForm;

      const isMap = tag === 'iframe' && 'data-coyote-map' in el.attribs && MAP_EMBED.test(attr('src') ?? '') && ++maps === 1;
      if (FORBIDDEN_ELEMENTS.has(tag) && !isMap) violations.push({ code: 'forbidden-element', detail: `<${tag}>` });

      for (const [name, value] of Object.entries(el.attribs)) {
        if (name === 'style') violations.push(...cssViolations(value, `${tag}[style]`));
        if (name === 'srcdoc' || name === 'formaction') violations.push({ code: 'forbidden-attribute', detail: `${tag}[${name}]` });
        if ((name === 'href' || name === 'xlink:href') && tag !== 'a' && tag !== 'link' && !value.trim().startsWith('#')) {
          violations.push({ code: 'forbidden-url', detail: `${tag}[${name}]: ${value.slice(0, 80)}` });
        }
      }

      if (tag === 'meta' && attr('http-equiv')?.toLowerCase() === 'refresh') {
        violations.push({ code: 'forbidden-element', detail: '<meta http-equiv="refresh">' });
      }

      if (tag === 'a' || tag === 'area') {
        const href = attr('href');
        if (href !== undefined && !urlAllowed(href.trim(), 'link', platformOrigins)) {
          violations.push({ code: 'forbidden-url', detail: `a[href]: ${href.slice(0, 80)}` });
        }
        if (href !== undefined && whatsapp !== undefined && /^https:\/\/wa\.me\//i.test(href.trim()) && !new RegExp(`^https://wa\\.me/${whatsapp}(\\?|$)`).test(href.trim())) {
          violations.push({ code: 'forbidden-url', detail: `a[href]: wa.me link to another number` });
        }
      }

      if (tag === 'link') {
        const rels = (attr('rel') ?? '').toLowerCase().split(/\s+/);
        if (!rels.every((rel) => LINK_RELS.has(rel))) violations.push({ code: 'forbidden-element', detail: `<link rel="${attr('rel')}">` });
        if (!urlAllowed((attr('href') ?? '').trim(), 'resource', platformOrigins)) {
          violations.push({ code: 'forbidden-url', detail: `link[href]: ${attr('href')?.slice(0, 80)}` });
        }
      }

      for (const name of ['src', 'srcset', 'poster', 'data', 'background'] as const) {
        const value = attr(name);
        if (value === undefined || (isMap && name === 'src')) continue;
        if (name === 'src' && /^data:image\/svg\+xml[,;]/i.test(value.trim())) continue;
        const targets = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value.trim()];
        // Images may come from any https: host; scripts only from the CDNs.
        const ok = (target: string) => isRelative(target) || (tag === 'script' ? fromOrigins(target, SCRIPT_ORIGINS) : isHttpsUrl(target));
        if (!targets.every(ok)) violations.push({ code: 'forbidden-url', detail: `${tag}[${name}]: ${value.slice(0, 80)}` });
      }

      if (tag === 'form') {
        const allowed =
          contactFormAction !== undefined &&
          'data-coyote-contact' in el.attribs &&
          attr('action') === contactFormAction &&
          attr('method')?.toLowerCase() === 'post';
        if (allowed) inForm = true;
        else violations.push({ code: 'forbidden-form', detail: `<form action="${attr('action') ?? ''}">` });
      }

      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
        const type = (attr('type') ?? (tag === 'input' ? 'text' : '')).toLowerCase();
        const typeOk = tag !== 'input' || FORM_FIELD_TYPES.has(type);
        if (!inForm || !typeOk || tag === 'select') {
          violations.push({ code: 'forbidden-form', detail: `<${tag} type="${type}">` });
        }
      }

      if (tag === 'style') {
        const css = el.children.map((child) => ('data' in child ? child.data : '')).join('');
        violations.push(...cssViolations(css, '<style>'));
      }

      el.children.forEach((child) => visit(child, inForm));
    }
  };

  parseDocument(page).children.forEach((child) => visit(child, false));
  return violations;
}
