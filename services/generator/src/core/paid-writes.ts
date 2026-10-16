import type { Stores } from './jobs';
import { emailId } from './token';

/**
 * Paid-tier page writes (models.ts tiers: Opus today) each email gets for free: the first design and 2 redesigns.
 * Free-tier writes (Haiku) and photo swaps use none. Claimed atomically right before the page writer runs, given back
 * when the page fails through our fault. Once they are used up, Mi sitio shows a banner and redesigns answer 402.
 * A design pack bought through Paddle (payments.ts) raises the email's allowance by DESIGNS_PER_PACK.
 */
export const PAID_WRITES_PER_EMAIL = 3;
export const DESIGNS_PER_PACK = 3;

/** Kept for years, like the free draft: the count must outlive the draft and the account. */
const TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

const key = (ownerEmailId: string) => `paid-writes#${ownerEmailId}`;
const boughtKey = (ownerEmailId: string) => `designs-bought#${ownerEmailId}`;

/** Designs the email bought, all packs together. */
export function boughtDesigns(stores: Stores, ownerEmailId: string): Promise<number> {
  return stores.getCount(boughtKey(ownerEmailId));
}

const allowance = async (stores: Stores, ownerEmailId: string) => PAID_WRITES_PER_EMAIL + (await boughtDesigns(stores, ownerEmailId));

/** How many the email has left. Takes the email's hash (token.ts `emailId`), as sites keep it. */
export async function paidWritesLeft(stores: Stores, ownerEmailId: string): Promise<number> {
  const [max, used] = await Promise.all([allowance(stores, ownerEmailId), stores.getCount(key(ownerEmailId))]);
  return Math.max(0, max - used);
}

export async function claimPaidWrite(stores: Stores, ownerEmailId: string, now: number): Promise<boolean> {
  return stores.hitRateLimit(key(ownerEmailId), await allowance(stores, ownerEmailId), Math.floor(now / 1000) + TTL_SECONDS);
}

/** A paid pack: adds `designs` once per payment (`paymentId`), so a retried webhook adds nothing. */
export function addBoughtDesigns(stores: Stores, ownerEmailId: string, paymentId: string, designs: number, now: number): Promise<boolean> {
  const ttl = Math.floor(now / 1000) + TTL_SECONDS;
  return stores.addOnce(`payment#${paymentId}`, boughtKey(ownerEmailId), designs, ttl);
}

export async function returnPaidWrite(stores: Stores, ownerEmailId: string): Promise<void> {
  await stores.releaseRateLimit(key(ownerEmailId)).catch(() => undefined);
}

/** Support or testing: the email gets all of them back. */
export async function resetPaidWrites(stores: Stores, email: string): Promise<void> {
  const id = emailId(email);
  while ((await stores.getCount(key(id))) > 0) await stores.releaseRateLimit(key(id));
}
