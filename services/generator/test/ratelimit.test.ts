import { describe, expect, it } from 'vitest';
import { REQUESTS_PER_IP_PER_MINUTE, withinMinuteLimit } from '../src/core/ratelimit';
import { memoryStores } from './memory-stores';

describe('withinMinuteLimit', () => {
  const now = 1_800_000_000_000;

  it('counts each visitor per minute, separately', async () => {
    const { stores } = memoryStores();
    for (let i = 0; i < REQUESTS_PER_IP_PER_MINUTE; i++) expect(await withinMinuteLimit(stores, '1.1.1.1', 's', now)).toBe(true);
    expect(await withinMinuteLimit(stores, '1.1.1.1', 's', now)).toBe(false);
    expect(await withinMinuteLimit(stores, '2.2.2.2', 's', now)).toBe(true);
    expect(await withinMinuteLimit(stores, '1.1.1.1', 's', now + 60_000)).toBe(true); // the next minute
  });

  it('lets the request through when the count fails', async () => {
    const failing = { hitRateLimit: async () => Promise.reject(new Error('DynamoDB down')) };
    expect(await withinMinuteLimit(failing, '1.1.1.1', 's', now)).toBe(true);
  });
});
