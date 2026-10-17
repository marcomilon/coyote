import { describe, expect, it } from 'vitest';
import { countUsage, tally, usageOf } from '../src/core/email-usage';
import { runGenerateJob } from '../src/core/generate-job';
import { DEFAULT_IMAGE_MODEL_ID, DEFAULT_MODEL_ID, DEFAULT_PRESCREEN_MODEL_ID } from '../src/core/models';
import { editSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { emailId } from '../src/core/token';
import { body, harness } from './harness';
import { memoryStores } from './memory-stores';

const call = (modelId: string, step = 'write_page', inputTokens = 1_000_000, outputTokens = 0) => ({ step, modelId, inputTokens, outputTokens });

describe('model calls per email', () => {
  it('tallies calls by tier, with their cost', () => {
    expect(tally([call('claude-opus-5-5'), call(DEFAULT_IMAGE_MODEL_ID, 'make_image', 0), call(DEFAULT_MODEL_ID), call(DEFAULT_PRESCREEN_MODEL_ID)])).toEqual({
      paid: 2,
      free: 2,
      microUsd: 4_000_000 + 40_000 + 1_100_000 + 330_000,
      models: {
        'claude-opus-5-5': { calls: 1, microUsd: 4_000_000 },
        [DEFAULT_IMAGE_MODEL_ID]: { calls: 1, microUsd: 40_000 },
        [DEFAULT_MODEL_ID]: { calls: 1, microUsd: 1_100_000 },
        [DEFAULT_PRESCREEN_MODEL_ID]: { calls: 1, microUsd: 330_000 },
      },
    });
  });

  it('keeps all-time and monthly counts', async () => {
    const { stores } = memoryStores();
    const id = emailId('Luna@Example.com');
    await countUsage(stores, id, [call('claude-opus-5-5')], Date.UTC(2026, 9, 15));
    await countUsage(stores, id, [call(DEFAULT_MODEL_ID)], Date.UTC(2026, 10, 2));
    expect(await usageOf(stores, id, Date.UTC(2026, 10, 20))).toEqual({
      all: { paid: 1, free: 1, microUsd: 5_100_000, models: { 'claude-opus-5-5': { calls: 1, microUsd: 4_000_000 }, [DEFAULT_MODEL_ID]: { calls: 1, microUsd: 1_100_000 } } },
      month: { paid: 0, free: 1, microUsd: 1_100_000, models: { [DEFAULT_MODEL_ID]: { calls: 1, microUsd: 1_100_000 } } },
      monthName: '2026-11',
    });
  });

  it('counts a new site and its redesign for the owner, every call once', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    await runGenerateJob('job-1', t.generateDeps); // a retry is skipped: nothing counted twice
    await editSite(t.sites.get('panaderia-luna')!, { instruction: 'todo en verde' }, t.ownerDeps);
    await runGenerateJob('job-2', t.generateDeps);
    const calls = t.jobs.get('job-1')!.usage.length + t.jobs.get('job-2')!.usage.length;
    const { all } = await usageOf(t.stores, emailId(body.ownerEmail), t.generateDeps.now());
    expect(all.paid + all.free).toBe(calls);
    expect(all.paid).toBeGreaterThan(0);
    expect(Object.values(all.models).reduce((n, m) => n + m.calls, 0)).toBe(calls);
  });
});
