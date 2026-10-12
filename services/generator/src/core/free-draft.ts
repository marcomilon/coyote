import type { Stores } from './jobs';
import { emailId } from './token';

/**
 * One free draft per email. A draft costs a page model call (Opus: about $0.50), and only one site per owner is likely
 * to be paid for, so a second one waits for publishing. Deleting the draft does not give it back.
 */
export const FREE_DRAFTS_PER_EMAIL = 1;

/** Kept for years: the count must outlive the draft and the account. */
const TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

const key = (email: string) => `free-draft#${emailId(email)}`;

/** Cheap check at submit, before any model call. The claim before the page model is what holds. */
export async function hasFreeDraftLeft(stores: Stores, email: string): Promise<boolean> {
  return (await stores.getCount(key(email))) < FREE_DRAFTS_PER_EMAIL;
}

/** Atomic, right before the page model writes a new site. Resolves to false when the email already used its draft. */
export function claimFreeDraft(stores: Stores, email: string, now: number): Promise<boolean> {
  return stores.hitRateLimit(key(email), FREE_DRAFTS_PER_EMAIL, Math.floor(now / 1000) + TTL_SECONDS);
}

/** The page could not be made through our fault (a failure, not a rejection): the owner may try again. */
export async function returnFreeDraft(stores: Stores, email: string): Promise<void> {
  await stores.releaseRateLimit(key(email)).catch(() => undefined);
}
