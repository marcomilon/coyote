import { createHash } from 'node:crypto';

/** IPs are stored only as salted hashes. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/** Requests one visitor may make to the API per minute, on every route. Polling pages use about 50. */
export const REQUESTS_PER_IP_PER_MINUTE = 240;

/** Flood guard in front of every API route: one counter per visitor per minute. Lets the request through if the count fails. */
export async function withinMinuteLimit(stores: { hitRateLimit(key: string, max: number, ttl: number): Promise<boolean> }, ip: string, salt: string, now: number): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  try {
    return await stores.hitRateLimit(`minute#${hashIp(ip, salt)}#${minute}`, REQUESTS_PER_IP_PER_MINUTE, Math.floor(now / 1000) + 120);
  } catch {
    return true;
  }
}

/** One counter per visitor per UTC day. */
export function rateLimitKey(ipHash: string, now: number): { key: string; ttl: number } {
  const day = new Date(now).toISOString().slice(0, 10);
  return { key: `${ipHash}#${day}`, ttl: Math.floor(now / 1000) + 2 * 24 * 60 * 60 };
}
