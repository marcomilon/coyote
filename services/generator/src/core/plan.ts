// The site's monthly plan (payments.ts), as the rest of the app reads it.
import type { SiteRecord } from './jobs';

export type Plan = 'none' | 'active' | 'past_due' | 'paused' | 'canceled';

/** The site's plan as the owner sees it. `past_due` still counts as paid while Paddle retries the card. */
export function planOf(site: SiteRecord): Plan {
  const status = site.billing?.status;
  if (!status) return 'none';
  if (status === 'active' || status === 'trialing') return 'active';
  return status === 'past_due' || status === 'paused' ? status : 'canceled';
}

export const isSubscribed = (site: SiteRecord) => ['active', 'past_due'].includes(planOf(site));

/** A plan we run ourselves for a customer we invited (`./coyote.sh domain-attach`): no Paddle subscription behind it. */
export const INVITED = 'invited';
export const isInvited = (site: SiteRecord) => site.billing?.subscriptionId === INVITED;
