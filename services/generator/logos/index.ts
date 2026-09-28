import { escapeHtml, raw, type SafeHtml } from '../src/core/html';

/**
 * Logo marks built from the business initials. Vector, deterministic, always in the page's colors.
 * (Diffusion models garble text and ignore the palette.) An uploaded logo replaces the mark.
 */
export interface MarkInput {
  businessName: string;
  ink: string;
  paper: string;
  accent: string;
  onAccent: string;
  /** CSS font-family for inline use. The favicon falls back to a generic family: a data URI cannot load web fonts. */
  fontFamily: string;
  fontWeight: number;
}

const SKIP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'da', 'do', 'das', 'dos', 'the', 'and', '&']);

export function initials(businessName: string): string {
  const words = businessName.normalize('NFKD').replace(/\p{M}/gu, '').split(/[^A-Za-z0-9]+/).filter((w) => w && !SKIP.has(w.toLowerCase()));
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return letters || 'C';
}

type Template = (i: MarkInput & { text: string; font: string }) => string;

const text = (i: { text: string; font: string; fontWeight: number }, fill: string, size: number, y = 50) =>
  `<text x="50" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="${i.font}" font-weight="${i.fontWeight}" font-size="${size}" fill="${fill}">${escapeHtml(i.text)}</text>`;

const TEMPLATES: Template[] = [
  // Solid circle
  (i) => `<circle cx="50" cy="50" r="48" fill="${i.accent}"/>${text(i, i.onAccent, 40)}`,
  // Ring
  (i) => `<circle cx="50" cy="50" r="45" fill="${i.paper}" stroke="${i.ink}" stroke-width="5"/><circle cx="50" cy="50" r="37" fill="none" stroke="${i.accent}" stroke-width="2"/>${text(i, i.ink, 36)}`,
  // Rounded square
  (i) => `<rect x="3" y="3" width="94" height="94" rx="22" fill="${i.ink}"/>${text(i, i.paper, 42)}`,
  // Shield
  (i) => `<path d="M50 3 93 17v32c0 25-18 40-43 48C25 89 7 74 7 49V17z" fill="${i.accent}"/>${text(i, i.onAccent, 36, 46)}`,
  // Diamond
  (i) => `<rect x="15" y="15" width="70" height="70" rx="8" transform="rotate(45 50 50)" fill="${i.accent}"/>${text(i, i.onAccent, 34)}`,
  // Split
  (i) => `<rect x="3" y="3" width="94" height="94" rx="12" fill="${i.accent}"/><path d="M3 97 97 3v82a12 12 0 0 1-12 12z" fill="${i.ink}" opacity=".9"/>${text(i, i.paper, 40)}`,
];

function hash(value: string): number {
  let h = 2166136261;
  for (let n = 0; n < value.length; n++) h = Math.imul(h ^ value.charCodeAt(n), 16777619);
  return h >>> 0;
}

function svg(input: MarkInput, seed: string, font: string, attributes: string): string {
  const template = TEMPLATES[hash(seed) % TEMPLATES.length]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ${attributes}>${template({ ...input, text: initials(input.businessName), font })}</svg>`;
}

/** Inline mark for the page. `seed` (the slug) picks the template, so a site keeps its mark across re-renders. */
export function markSvg(input: MarkInput, seed: string): SafeHtml {
  // Every value is either validated (hex colors, allowlisted font) or escaped (the initials).
  return raw(svg(input, seed, escapeHtml(input.fontFamily), 'class="mark" role="img" aria-hidden="true"'));
}

/** `data:` URI for <link rel="icon">. */
export function faviconDataUri(input: MarkInput, seed: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg(input, seed, 'Arial Black,Arial,sans-serif', ''))}`;
}
