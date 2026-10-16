import type { Stores } from './jobs';
import type { Announce } from './notices';
import { emailId } from './token';

/**
 * Accounts that keep sending what the safety layers refuse. Each refusal of the owner's own text (the input
 * guardrail, or a policy rejection by the pre-screen) counts for their email; FREEZE_AFTER of them within
 * FREEZE_WINDOW_SECONDS of the first freezes the account: no new sites, edits, chat or design changes (423 `frozen`),
 * the draft stays viewable, and the admin hears of it. Only `./coyote.sh unfreeze <email>` lifts it. A refused page
 * (output checks) or an unclear description doesn't count: those aren't the owner's attacks.
 */
export const FREEZE_AFTER = 5;
export const FREEZE_WINDOW_SECONDS = 24 * 60 * 60;
/** Kept like the free draft: until someone lifts it. */
const FROZEN_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

const refusalsKey = (ownerEmailId: string) => `refusals#${ownerEmailId}`;
const frozenKey = (ownerEmailId: string) => `frozen#${ownerEmailId}`;

export async function isFrozen(stores: Pick<Stores, 'getCount'>, ownerEmailId: string | undefined): Promise<boolean> {
  return !!ownerEmailId && (await stores.getCount(frozenKey(ownerEmailId))) > 0;
}

/**
 * Counts one refusal of the owner's text. Resolves to true when this one froze the account. Never fails the flow:
 * a lost count is only logged.
 */
export async function noteRefusal(
  stores: Pick<Stores, 'increment' | 'getAccount'>,
  ownerEmailId: string | undefined,
  now: number,
  { announce, where, text }: { announce?: Announce; where: string; text: string },
): Promise<boolean> {
  if (!ownerEmailId) return false;
  try {
    const seconds = Math.floor(now / 1000);
    const count = await stores.increment(refusalsKey(ownerEmailId), seconds + FREEZE_WINDOW_SECONDS);
    if (count < FREEZE_AFTER) return false;
    // The first time over the limit freezes; later refusals only add to the count.
    if ((await stores.increment(frozenKey(ownerEmailId), seconds + FROZEN_TTL_SECONDS)) !== 1) return false;
    const email = (await stores.getAccount(ownerEmailId))?.email ?? ownerEmailId;
    await announce?.(`Cuenta pausada: ${email}`.slice(0, 100), [`${email}: ${count} pedidos rechazados en 24 h.`, `Último (${where}): ${text.slice(0, 500)}`, '', `Para reactivarla: ./coyote.sh unfreeze ${email}`].join('\n')).catch((error: unknown) => console.error('admin notice failed', { error }));
    return true;
  } catch (error) {
    console.error('refusal count failed', { ownerEmailId, error });
    return false;
  }
}

/** Support: lifts the freeze and clears the count. */
export async function unfreeze(stores: Pick<Stores, 'getCount' | 'releaseRateLimit'>, email: string): Promise<void> {
  const id = emailId(email);
  for (const key of [frozenKey(id), refusalsKey(id)]) while ((await stores.getCount(key)) > 0) await stores.releaseRateLimit(key);
}
