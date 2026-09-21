import { createHash } from 'node:crypto';

/** IPs are stored only as salted hashes. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/** One counter per visitor per UTC day. */
export function rateLimitKey(ipHash: string, now: number): { key: string; ttl: number } {
  const day = new Date(now).toISOString().slice(0, 10);
  return { key: `${ipHash}#${day}`, ttl: Math.floor(now / 1000) + 2 * 24 * 60 * 60 };
}
