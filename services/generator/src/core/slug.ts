import { findBrand, normalizeForMatch } from './brands';

const MAX_LENGTH = 40; // a DNS label allows 63; leave room for the collision suffix
const FALLBACK = 'sitio';
const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes

/** Hostnames and path prefixes the platform uses. Anything starting with "_" is also reserved. */
const RESERVED = new Set([
  'www',
  'api',
  'app',
  'mail',
  'preview',
  'admin',
  'static',
  'assets',
  'dev',
  'notify',
  'coyote',
]);

export function slugify(businessName: string): string {
  const slug = normalizeForMatch(businessName)
    .replace(/ /g, '-')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '');
  return slug || FALLBACK;
}

export type SlugRejection = 'reserved' | 'brand';

/** Checked before claiming. The `blocklist` table is checked separately by the caller. */
export function rejectSlug(slug: string): SlugRejection | null {
  if (RESERVED.has(slug) || slug.startsWith('_')) return 'reserved';
  if (findBrand(slug, 'name')) return 'brand';
  return null;
}

/** Used only after the clean slug is taken. */
export function withSuffix(slug: string, random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)] ?? 'x';
  }
  return `${slug}-${suffix}`;
}
