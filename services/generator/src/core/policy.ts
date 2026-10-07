import { findBrand, normalizeForMatch } from './brands';

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
// Text checks (page-check.ts runs them on the finished page; the questions and the chat on their text)
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

/** Removes URLs from one text. Rendered text is never a link, but a visible URL can still send people somewhere. */
export function scrubText(text: string): string {
  return text
    .replace(URL_LIKE, '')
    // The page adds the owner's verified contact details itself. A number inside the copy is either a model
    // slip or an injected one, so it goes.
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
export function checkTexts(texts: string[], named: { businessName?: string; headlines?: string[] } = {}, ownerNumbers: string[] = []): Violation[] {
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
      // The owner's own phone numbers can pass the card checksum by chance (a 13-digit Argentine mobile).
      if (ownerNumbers.some((n) => n.endsWith(digits) || digits.endsWith(n))) continue;
      if (digits.length >= 13 && luhn(digits)) violations.push({ code: 'card-number', detail: `${digits.length} digits` });
    }
  }

  return violations;
}
