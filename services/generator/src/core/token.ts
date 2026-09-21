import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The magic-link token is "<slug>.<secret>". Only the hash of the secret is stored. */
export function issueToken(slug: string): { token: string; tokenHash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${slug}.${secret}`, tokenHash: sha256(secret) };
}

export function parseToken(token: string): { slug: string; secret: string } | undefined {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  return { slug: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export function secretMatches(secret: string, tokenHash: string): boolean {
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
