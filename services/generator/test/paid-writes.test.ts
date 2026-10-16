import { describe, expect, it } from 'vitest';
import { runGenerateJob } from '../src/core/generate-job';
import { editSite, ownerView } from '../src/core/owner';
import { addBoughtDesigns, boughtDesigns, PAID_WRITES_PER_EMAIL, paidWritesLeft, resetPaidWrites } from '../src/core/paid-writes';
import { submit } from '../src/core/submit';
import { emailId } from '../src/core/token';
import { body, harness } from './harness';

const redesign = async (t: ReturnType<typeof harness>, jobId: string, deps = t.generateDeps) => {
  const result = await editSite(t.sites.get('panaderia-luna')!, { instruction: 'todo en verde' }, t.ownerDeps);
  if (result.status === 202) await runGenerateJob(jobId, deps);
  return result.status;
};

describe('paid writes per email', () => {
  it('gives the first design and 2 redesigns, then closes redesigns with a banner', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const owner = emailId(body.ownerEmail);
    expect(PAID_WRITES_PER_EMAIL).toBe(3);
    expect(await paidWritesLeft(t.stores, owner)).toBe(2);
    expect(await redesign(t, 'job-2')).toBe(202);
    expect(await redesign(t, 'job-3')).toBe(202);
    expect(t.jobs.get('job-3')).toMatchObject({ status: 'DONE', paidWrite: owner });
    expect((await ownerView(t.sites.get('panaderia-luna')!, t.ownerDeps)).designsLeft).toBe(0);
    expect(await redesign(t, 'job-4')).toBe(402);
    // Text and contact edits stay open.
    expect((await editSite(t.sites.get('panaderia-luna')!, { contact: { address: 'Calle 1' } }, t.ownerDeps)).status).toBe(200);

    await resetPaidWrites(t.stores, body.ownerEmail);
    expect(await paidWritesLeft(t.stores, owner)).toBe(3);
  });

  it('a failed redesign gives its paid write back', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    t.writer.options.fail = new Error('Opus down');
    await redesign(t, 'job-2');
    expect(t.jobs.get('job-2')).toMatchObject({ status: 'FAILED' });
    expect(await paidWritesLeft(t.stores, emailId(body.ownerEmail))).toBe(2);
  });

  it('free-tier writes use none and have no limit', async () => {
    const t = harness();
    const deps = { ...t.generateDeps, pageModel: 'claude-haiku-4-5' };
    const ownerDeps = { ...t.ownerDeps, pageTier: async () => 'free' as const };
    await submit(body, '1.2.3.4', { ...t.submitDeps, pageTier: async () => 'free' as const });
    await runGenerateJob('job-1', deps);
    for (const id of ['job-2', 'job-3', 'job-4']) {
      expect((await editSite(t.sites.get('panaderia-luna')!, { instruction: 'todo en verde' }, ownerDeps)).status).toBe(202);
      await runGenerateJob(id, deps);
    }
    expect(await paidWritesLeft(t.stores, emailId(body.ownerEmail))).toBe(3);
    expect((await ownerView(t.sites.get('panaderia-luna')!, ownerDeps)).designsLeft).toBeUndefined();
  });

  it('a bought pack opens 3 more redesigns, once per payment', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const owner = emailId(body.ownerEmail);
    await redesign(t, 'job-2');
    await redesign(t, 'job-3');
    expect(await redesign(t, 'job-4')).toBe(402);

    expect(await addBoughtDesigns(t.stores, owner, 'txn_1', 3, Date.now())).toBe(true);
    expect(await addBoughtDesigns(t.stores, owner, 'txn_1', 3, Date.now())).toBe(false); // a retried webhook
    expect(await boughtDesigns(t.stores, owner)).toBe(3);
    expect((await ownerView(t.sites.get('panaderia-luna')!, t.ownerDeps)).designsLeft).toBe(3);
    // A refused redesign makes no job, so the ids go on from job-4.
    for (const id of ['job-4', 'job-5', 'job-6']) expect(await redesign(t, id)).toBe(202);
    expect(t.jobs.get('job-6')).toMatchObject({ status: 'DONE', paidWrite: owner });
    expect(await redesign(t, 'job-7')).toBe(402);

    // A second pack adds 3 more.
    await addBoughtDesigns(t.stores, owner, 'txn_2', 3, Date.now());
    expect(await paidWritesLeft(t.stores, owner)).toBe(3);
  });
});
