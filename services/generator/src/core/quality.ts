import { normalizeForMatch } from './brands';
import type { Brief } from './brief';
import { contrast, luminance } from './color';
import type { ModelContent } from './content';
import type { Lang } from './answers';
import { BANNED_PHRASES } from './prompt';
import type { Candidate } from './variety';

const HEADLINE_MAX_WORDS = 8;
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Makes the brief safe to render without another model call: the font must belong to the chosen theme's
 * candidates, and the palette must be readable and match the theme's light or dark scheme.
 */
export function fixBrief(brief: Brief, candidates: Candidate[]): Brief {
  const candidate = candidates.find((c) => c.theme.id === brief.theme) ?? candidates[0]!;
  const fontPairing = candidate.fontPairings.includes(brief.fontPairing as never) ? brief.fontPairing : candidate.fontPairings[0]!;

  const { ink, paper, accent } = brief.palette;
  const dark = luminance(paper) < 0.2;
  const readable = contrast(ink, paper) >= 7 && contrast(accent, paper) >= 3;
  const matchesScheme = dark === (candidate.theme.meta.scheme === 'dark');
  const palette = readable && matchesScheme ? brief.palette : candidate.theme.meta.defaultPalette;

  return { ...brief, theme: candidate.theme.id, fontPairing, palette };
}

/** Copy problems worth one regeneration. Messages are written for the model. */
/** Voseo forms, as written (accents matter: "contá" is voseo, "cuenta" is tuteo). */
const VOSEO = /(^|[^\p{L}])(contá|contanos|pedí|pedinos|escribí|escribinos|llamanos|visitanos|vení|mirá|consultá|agendá|reservá|tenés|podés|querés|sos|pasá|seguí|descubrí|probá|elegí|disfrutá|comprá|encontrá|sumate|animate|acercate)(?=[^\p{L}]|$)/iu;
/** Places where voseo is the norm. The answers decide; without a match, the copy uses tuteo. */
const VOSEO_PLACES = /argentin|uruguay|paraguay|buenos aires|montevideo|asunci[oó]n|rosario|mendoza|c[oó]rdoba, ar|la plata|mar del plata|tucum[aá]n|salta|neuqu[eé]n/i;

/**
 * Copy problems worth one regeneration. Messages are written for the model. `answersText` (the owner's own
 * words) decides whether voseo is right.
 */
export function lintContent(content: ModelContent, lang: Lang, answersText = ''): string[] {
  const problems: string[] = [];
  const texts = [content.title, content.headline, content.subhead, content.about, content.ctaText, ...content.services.flatMap((s) => [s.name, s.detail ?? ''])];

  const all = normalizeForMatch(texts.join(' \n '));
  for (const phrase of BANNED_PHRASES[lang]) {
    if (all.includes(normalizeForMatch(phrase))) problems.push(`Do not use the phrase "${phrase}" or a close variant.`);
  }
  if (content.headline.trim().split(/\s+/).length > HEADLINE_MAX_WORDS) {
    problems.push(`The headline has more than ${HEADLINE_MAX_WORDS} words. Make it shorter and concrete.`);
  }
  if (texts.some((text) => EMOJI.test(text))) problems.push('Remove every emoji.');
  if (/!{2,}|¡.*!.*¡.*!/.test(texts.join(' '))) problems.push('Too many exclamation marks. Use a calm, concrete voice.');
  const voseo = lang === 'es' && !VOSEO_PLACES.test(answersText) ? VOSEO.exec(texts.join(' \n '))?.[2] : undefined;
  if (voseo) problems.push(`"${voseo}" is voseo. This business is not in Argentina, Uruguay, or Paraguay: use tuteo (tú) everywhere.`);
  return problems;
}

/** The hero photo prompt must be English: a Spanish "llamas" (flames) became a llama in the photo. */
export function looksEnglish(text: string): boolean {
  // Function words, not accents: "Bogotá" or "São Paulo" belong in an English scene too.
  const words = text.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  const foreign = words.filter((w) => ['de', 'del', 'la', 'las', 'los', 'el', 'con', 'y', 'en', 'sobre', 'da', 'do', 'das', 'dos', 'com', 'e', 'em', 'um', 'uma', 'por', 'para', 'una', 'un', 'al'].includes(w)).length;
  return foreign <= 1;
}
