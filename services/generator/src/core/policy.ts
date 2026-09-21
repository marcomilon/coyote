import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { findBrand, normalizeForMatch } from './brands';
import type { ModelContent, SiteContent } from './content';

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
    | 'forbidden-css';
  detail: string;
}

/** Any violation rejects the site. Details are for our logs, never shown to the user. */
export class PolicyRejection extends Error {
  constructor(readonly violations: Violation[]) {
    super(`Policy rejection: ${violations.map((v) => `${v.code} (${v.detail})`).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Content JSON
// ---------------------------------------------------------------------------------------------

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|xyz|top|click|link|site|online|app|io|co|mx|br|ar|cl|pe|ec|uy|py|bo|ve)(?:\.[a-z]{2})?(?:\/\S*)?/gi;

/** Matched after normalizeForMatch (lowercase, no accents, single spaces). es + pt. */
const SCAM_PHRASES = [
  'verifica tu cuenta', 'verifique su cuenta', 'verifique sua conta', 'verifica tu identidad',
  'actualiza tus datos', 'actualice sus datos', 'atualize seus dados', 'confirme seus dados', 'confirma tus datos',
  'cuenta suspendida', 'cuenta bloqueada', 'cuenta sera suspendida', 'conta suspensa', 'conta bloqueada',
  'acceso restringido', 'desbloquea tu cuenta', 'desbloqueie sua conta',
  'has sido seleccionado', 'voce foi selecionado', 'reclama tu premio', 'resgate seu premio',
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

/** Removes URLs from one text. Rendered text is never a link, but a visible URL can still send people somewhere. */
export function scrubText(text: string): string {
  return text.replace(URL_LIKE, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

/** Removes URLs from every text field the model wrote. Run before validation. */
export function scrubModelContent(content: ModelContent): ModelContent {
  return {
    ...content,
    title: scrubText(content.title),
    description: scrubText(content.description),
    headline: scrubText(content.headline),
    subhead: scrubText(content.subhead),
    about: scrubText(content.about),
    ctaText: scrubText(content.ctaText),
    services: content.services.map((s) => ({ name: scrubText(s.name), detail: s.detail && scrubText(s.detail) })),
  };
}

export function checkContent(content: SiteContent): Violation[] {
  const violations: Violation[] = [];

  const nameBrand = findBrand(content.businessName, 'name');
  if (nameBrand) violations.push({ code: 'brand', detail: `businessName: ${nameBrand}` });
  for (const field of ['title', 'headline'] as const) {
    const brand = findBrand(content[field], 'copy');
    if (brand) violations.push({ code: 'brand', detail: `${field}: ${brand}` });
  }

  const texts = [
    content.businessName, content.title, content.description, content.headline, content.subhead, content.about,
    content.ctaText, content.contact.address ?? '',
    ...content.services.flatMap((s) => [s.name, s.detail ?? '']),
    ...(content.hours ?? []).flatMap((h) => [h.days, h.time]),
  ];

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
// Rendered HTML (renderer invariants; catches theme bugs)
// ---------------------------------------------------------------------------------------------

export interface HtmlPolicyOptions {
  /** Origins the platform itself links to: the app (report, privacy) and the site's own origin. */
  platformOrigins: string[];
  /** Exact `action` of the theme contact form. Unset (MVP) = no form allowed at all. */
  contactFormAction?: string;
}

const FORBIDDEN_ELEMENTS = new Set(['script', 'iframe', 'frame', 'object', 'embed', 'applet', 'base', 'portal', 'noscript']);
const FORM_FIELD_TYPES = new Set(['text', 'tel', 'email', 'hidden', 'submit']);
const LINK_HOSTS = new Set([
  'wa.me', 'api.whatsapp.com', 'instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com',
  'maps.google.com',
]);
const RESOURCE_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
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
  if (kind === 'resource') return RESOURCE_HOSTS.has(parsed.host);
  if (parsed.host === 'goo.gl') return parsed.pathname.startsWith('/maps');
  return LINK_HOSTS.has(parsed.host);
}

function cssViolations(css: string, where: string): Violation[] {
  const violations: Violation[] = [];
  if (/@import/i.test(css)) violations.push({ code: 'forbidden-css', detail: `${where}: @import` });
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    const target = match[2] ?? '';
    if (!/^data:image\//i.test(target) && !isRelative(target)) {
      violations.push({ code: 'forbidden-css', detail: `${where}: url(${target.slice(0, 60)})` });
    }
  }
  return violations;
}

export function checkHtml(page: string, options: HtmlPolicyOptions): Violation[] {
  const violations: Violation[] = [];
  const { platformOrigins, contactFormAction } = options;

  const visit = (node: ChildNode, insideContactForm: boolean): void => {
    if (node.type === 'script' || node.type === 'style' || node.type === 'tag') {
      const el = node as Element;
      const tag = el.name.toLowerCase();
      const attr = (name: string) => el.attribs[name];
      let inForm = insideContactForm;

      if (FORBIDDEN_ELEMENTS.has(tag)) violations.push({ code: 'forbidden-element', detail: `<${tag}>` });

      for (const [name, value] of Object.entries(el.attribs)) {
        if (/^on/i.test(name)) violations.push({ code: 'forbidden-attribute', detail: `${tag}[${name}]` });
        if (name === 'style') violations.push(...cssViolations(value, `${tag}[style]`));
        if (name === 'srcdoc' || name === 'formaction') violations.push({ code: 'forbidden-attribute', detail: `${tag}[${name}]` });
      }

      if (tag === 'meta' && attr('http-equiv')?.toLowerCase() === 'refresh') {
        violations.push({ code: 'forbidden-element', detail: '<meta http-equiv="refresh">' });
      }

      if (tag === 'a' || tag === 'area') {
        const href = attr('href');
        if (href !== undefined && !urlAllowed(href.trim(), 'link', platformOrigins)) {
          violations.push({ code: 'forbidden-url', detail: `a[href]: ${href.slice(0, 80)}` });
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
        if (value === undefined) continue;
        const targets = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value.trim()];
        if (!targets.every(isRelative)) violations.push({ code: 'forbidden-url', detail: `${tag}[${name}]: ${value.slice(0, 80)}` });
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
