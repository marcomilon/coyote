import type { Usage } from './bedrock';
import type { Stores } from './jobs';
import { modelTier, usageCost } from './models';

/**
 * Model calls per owner email, by tier (models.ts), with their cost: all time and per month, for `./coyote.sh usage`.
 * Keyed by the email's hash (token.ts `emailId`), in the rate-limit table next to the free draft.
 */
export interface UsageCount {
  paid: number;
  free: number;
  /** Model prices only (usageCost); calls with no listed price add nothing. */
  microUsd: number;
}

/** Kept like the free draft: years. A month's count is kept a little over a year. */
const ALL_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;
const MONTH_TTL_SECONDS = 400 * 24 * 60 * 60;

const month = (now: number) => new Date(now).toISOString().slice(0, 7);
const allKey = (id: string) => `usage#${id}`;
const monthKey = (id: string, now: number) => `usage#${id}#${month(now)}`;

export function tally(usage: Usage[]): UsageCount {
  const count: UsageCount = { paid: 0, free: 0, microUsd: 0 };
  for (const u of usage) {
    count[modelTier(u.modelId)]++;
    count.microUsd += Math.round((usageCost(u) ?? 0) * 1_000_000);
  }
  return count;
}

/** Adds these calls to the email's counts. Never fails the flow that made them: a lost count is only logged. */
export async function countUsage(stores: Stores, ownerEmailId: string | undefined, usage: Usage[], now: number): Promise<void> {
  if (!ownerEmailId || usage.length === 0) return;
  const count = tally(usage);
  const seconds = Math.floor(now / 1000);
  try {
    await Promise.all([stores.addUsage(allKey(ownerEmailId), count, seconds + ALL_TTL_SECONDS), stores.addUsage(monthKey(ownerEmailId, now), count, seconds + MONTH_TTL_SECONDS)]);
  } catch (error) {
    console.error('usage count failed', { ownerEmailId, count, error });
  }
}

/** The email's counts: all time and this month. */
export async function usageOf(stores: Stores, ownerEmailId: string, now: number): Promise<{ all: UsageCount; month: UsageCount; monthName: string }> {
  const [all, thisMonth] = await Promise.all([stores.getUsage(allKey(ownerEmailId)), stores.getUsage(monthKey(ownerEmailId, now))]);
  return { all, month: thisMonth, monthName: month(now) };
}
