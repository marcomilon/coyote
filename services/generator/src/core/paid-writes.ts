import type { Stores } from './jobs';
import { emailId } from './token';

/**
 * Paid-tier page writes (models.ts tiers: Opus today) each email gets for free: the first design and 2 redesigns.
 * Free-tier writes (Haiku) and photo swaps use none. Claimed atomically right before the page writer runs, given back
 * when the page fails through our fault. Once they are used up, Mi sitio shows a banner and redesigns answer 402.
 */
export const PAID_WRITES_PER_EMAIL = 3;

/** Kept for years, like the free draft: the count must outlive the draft and the account. */
const TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

const key = (ownerEmailId: string) => `paid-writes#${ownerEmailId}`;

/** How many the email has left. Takes the email's hash (token.ts `emailId`), as sites keep it. */
export async function paidWritesLeft(stores: Stores, ownerEmailId: string): Promise<number> {
  return Math.max(0, PAID_WRITES_PER_EMAIL - (await stores.getCount(key(ownerEmailId))));
}

export function claimPaidWrite(stores: Stores, ownerEmailId: string, now: number): Promise<boolean> {
  return stores.hitRateLimit(key(ownerEmailId), PAID_WRITES_PER_EMAIL, Math.floor(now / 1000) + TTL_SECONDS);
}

export async function returnPaidWrite(stores: Stores, ownerEmailId: string): Promise<void> {
  await stores.releaseRateLimit(key(ownerEmailId)).catch(() => undefined);
}

/** Support or testing: the email gets all of them back. */
export async function resetPaidWrites(stores: Stores, email: string): Promise<void> {
  const id = emailId(email);
  while ((await stores.getCount(key(id))) > 0) await stores.releaseRateLimit(key(id));
}
