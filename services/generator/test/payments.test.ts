import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureMatches } from '../src/aws/paddle';
import { checkout, handleEvent, portal, type PaymentDeps, type Payments } from '../src/core/payments';
import { INVITED } from '../src/core/plan';
import { planOf } from '../src/core/plan';
import { boughtDesigns, paidWritesLeft } from '../src/core/paid-writes';
import type { SiteRecord } from '../src/core/jobs';
import { memoryStores } from './memory-stores';

const PRICE = 'pri_designs';
const HOSTING = 'pri_hosting';
const site = { slug: 'panaderia-luna', ownerEmailId: 'email-hash' } as SiteRecord;

function setup(tier: 'paid' | 'free' = 'paid') {
  const { stores } = memoryStores();
  const made: { priceId: string; customData: Record<string, string> }[] = [];
  const payments: Payments = {
    async createTransaction(priceId, customData) {
      made.push({ priceId, customData });
      return 'txn_new';
    },
    verify: async () => true,
    portalUrl: async (customerId, subscriptionId) => `https://portal.test/${customerId}/${subscriptionId}`,
  };
  const queued: { slug: string; domain: string }[] = [];
  const queue = { fail: false };
  const deps: PaymentDeps = {
    stores,
    payments,
    designsPriceId: PRICE,
    hostingPriceId: HOSTING,
    registrar: { check: async (domains) => domains.map((domain) => (domain === 'luna.com' ? { domain, status: 'taken' as const } : { domain, status: 'available' as const, priceCents: 1108 })) },
    async queueDomainOrder(slug, domain) {
      if (queue.fail) throw new Error('sqs down');
      queued.push({ slug, domain });
    },
    pageTier: async () => tier,
    now: () => 1_700_000_000_000,
  };
  return { stores, made, deps, queued, queue };
}

const completed = (overrides: Record<string, unknown> = {}, custom: Record<string, unknown> = { app: 'coyote', kind: 'designs', emailId: 'email-hash' }) => ({
  event_type: 'transaction.completed',
  data: { id: 'txn_1', custom_data: custom, items: [{ price: { id: PRICE } }], ...overrides },
});

describe('design packs', () => {
  it('checkout makes the transaction on the server, for the site owner', async () => {
    const t = setup();
    expect(await checkout(site, t.deps)).toEqual({ status: 200, transactionId: 'txn_new' });
    expect(t.made).toEqual([{ priceId: PRICE, customData: { app: 'coyote', kind: 'designs', emailId: 'email-hash', slug: 'panaderia-luna' } }]);
  });

  it('checkout is closed while page writes are free-tier, or without an owner', async () => {
    expect(await checkout(site, setup('free').deps)).toEqual({ status: 409, error: 'not_needed' });
    expect((await checkout({ slug: 'x' } as SiteRecord, setup().deps)).status).toBe(409);
  });

  it('a completed pack adds 3 designs once', async () => {
    const t = setup();
    expect(await handleEvent(completed(), t.deps)).toBe('added');
    expect(await handleEvent(completed(), t.deps)).toBe('repeated');
    expect(await boughtDesigns(t.stores, 'email-hash')).toBe(3);
    expect(await paidWritesLeft(t.stores, 'email-hash')).toBe(6);
  });

  it('ignores other apps, other events and other prices', async () => {
    const t = setup();
    expect(await handleEvent(completed({}, { app: 'guardiana', kind: 'designs', emailId: 'email-hash' }), t.deps)).toBe('ignored');
    expect(await handleEvent({ ...completed(), event_type: 'transaction.paid' }, t.deps)).toBe('ignored');
    expect(await handleEvent(completed({ items: [{ price: { id: 'pri_other' } }] }), t.deps)).toBe('ignored');
    expect(await handleEvent(completed({ custom_data: null }), t.deps)).toBe('ignored');
    expect(await boughtDesigns(t.stores, 'email-hash')).toBe(0);
  });
});

const subscriptionEvent = (type: string, status: string, at: string, overrides: Record<string, unknown> = {}) => ({
  event_type: type,
  occurred_at: at,
  data: {
    id: 'sub_1', status, customer_id: 'ctm_1', next_billed_at: '2026-11-16T00:00:00Z',
    custom_data: { app: 'coyote', kind: 'hosting', emailId: 'email-hash', slug: 'panaderia-luna', domain: 'sol.com' },
    items: [{ price: { id: HOSTING } }],
    ...overrides,
  },
});

describe('the monthly plan', () => {
  function withSite(tier: 'paid' | 'free' = 'paid') {
    const t = setup(tier);
    void t.stores.saveSite({ ...site, status: 'draft', jobId: 'job-0', createdAt: 0 });
    const current = async () => (await t.stores.getSite(site.slug))!;
    return { ...t, current };
  }

  it('checkout makes a transaction for the plan and its domain, even while page writes are free-tier', async () => {
    const t = withSite('free');
    expect(await checkout(await t.current(), t.deps, 'hosting', ' Sol.com')).toEqual({ status: 200, transactionId: 'txn_new' });
    expect(t.made).toEqual([{ priceId: HOSTING, customData: { app: 'coyote', kind: 'hosting', emailId: 'email-hash', slug: 'panaderia-luna', domain: 'sol.com' } }]);
  });

  it('checkout refuses a taken or invalid domain, or a site that has one', async () => {
    const t = withSite();
    expect(await checkout(await t.current(), t.deps, 'hosting', 'luna.com')).toEqual({ status: 409, error: 'not_available' });
    expect(await checkout(await t.current(), t.deps, 'hosting', 'sol.net')).toEqual({ status: 400 });
    expect(await checkout(await t.current(), t.deps, 'hosting')).toEqual({ status: 400 });
    expect(await checkout({ ...(await t.current()), domain: 'otro.com' }, t.deps, 'hosting', 'sol.com')).toEqual({ status: 409, error: 'has_domain' });
    expect(t.made).toEqual([]);
  });

  it('once active, the domain is ordered and queued once', async () => {
    const t = withSite();
    await handleEvent(subscriptionEvent('subscription.created', 'active', '2026-10-16T10:00:00Z'), t.deps);
    await handleEvent(subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:01Z'), t.deps);
    expect(t.queued).toEqual([{ slug: 'panaderia-luna', domain: 'sol.com' }]);
    expect((await t.current()).domainOrder).toEqual({ domain: 'sol.com', at: 1_700_000_000_000 });
  });

  it('a canceled plan, or one without a domain, orders nothing', async () => {
    const t = withSite();
    await handleEvent(subscriptionEvent('subscription.canceled', 'canceled', '2026-10-16T10:00:00Z'), t.deps);
    const event = subscriptionEvent('subscription.activated', 'active', '2026-10-16T11:00:00Z');
    await handleEvent({ ...event, data: { ...event.data, custom_data: { app: 'coyote', kind: 'hosting', slug: 'panaderia-luna' } } }, t.deps);
    expect(t.queued).toEqual([]);
    expect((await t.current()).domainOrder).toBeUndefined();
  });

  it('if the queue is down, the order is undone so Paddle\'s retry orders it again', async () => {
    const t = withSite();
    t.queue.fail = true;
    await expect(handleEvent(subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:00Z'), t.deps)).rejects.toThrow('sqs down');
    expect((await t.current()).domainOrder).toBeUndefined();
    t.queue.fail = false;
    await handleEvent(subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:00Z'), t.deps);
    expect(t.queued).toHaveLength(1);
  });

  it('subscription events set the plan on the site; an older one never undoes a newer one', async () => {
    const t = withSite();
    expect(planOf(await t.current())).toBe('none');
    expect(await handleEvent(subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:00Z'), t.deps)).toBe('billed');
    expect((await t.current()).billing).toEqual({ subscriptionId: 'sub_1', customerId: 'ctm_1', status: 'active', nextBilledAt: '2026-11-16T00:00:00Z', updatedAt: Date.parse('2026-10-16T10:00:00Z') });
    expect(planOf(await t.current())).toBe('active');
    expect(await checkout(await t.current(), t.deps, 'hosting', 'sol.com')).toEqual({ status: 409, error: 'subscribed' });

    expect(await handleEvent(subscriptionEvent('subscription.canceled', 'canceled', '2026-10-16T12:00:00Z', { next_billed_at: null }), t.deps)).toBe('billed');
    expect(await handleEvent(subscriptionEvent('subscription.created', 'active', '2026-10-16T09:59:00Z'), t.deps)).toBe('stale');
    expect(planOf(await t.current())).toBe('canceled');
    expect((await t.current()).billing?.nextBilledAt).toBeUndefined();
  });

  it('ignores other apps, other prices, and sites that are gone', async () => {
    const t = withSite();
    const event = subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:00Z');
    expect(await handleEvent({ ...event, data: { ...event.data, custom_data: { app: 'guardiana', kind: 'hosting', slug: 'panaderia-luna' } } }, t.deps)).toBe('ignored');
    expect(await handleEvent({ ...event, data: { ...event.data, items: [{ price: { id: PRICE } }] } }, t.deps)).toBe('ignored');
    expect(await handleEvent({ ...event, data: { ...event.data, custom_data: { app: 'coyote', kind: 'hosting', slug: 'gone' } } }, t.deps)).toBe('stale');
    expect(planOf(await t.current())).toBe('none');
  });

  it('the portal needs a plan', async () => {
    const t = withSite();
    expect(await portal(await t.current(), t.deps)).toEqual({ status: 409 });
    await handleEvent(subscriptionEvent('subscription.activated', 'active', '2026-10-16T10:00:00Z'), t.deps);
    expect(await portal(await t.current(), t.deps)).toEqual({ status: 200, url: 'https://portal.test/ctm_1/sub_1' });
  });

  it('an invited customer\'s plan is ours: no Paddle portal', async () => {
    const t = withSite();
    await t.stores.saveBilling((await t.current()).slug, { subscriptionId: INVITED, customerId: INVITED, status: 'active', updatedAt: 1 });
    expect(await portal(await t.current(), t.deps)).toEqual({ status: 409 });
  });
});

describe('Paddle webhook signature', () => {
  const secret = 'pdl_ntfset_secret';
  const body = '{"event_type":"transaction.completed"}';
  const sign = (ts: number, raw = body, key = secret) => `ts=${ts};h1=${createHmac('sha256', key).update(`${ts}:${raw}`).digest('hex')}`;
  const now = 1_700_000_000;

  it('accepts a recent signature of this exact body', () => {
    expect(signatureMatches(body, sign(now), secret, now + 10)).toBe(true);
    expect(signatureMatches(body, `${sign(now)};h1=00`, secret, now)).toBe(true); // a rotating secret sends two
  });

  it('rejects another body, another key, an old signature or none', () => {
    expect(signatureMatches(body + ' ', sign(now), secret, now)).toBe(false);
    expect(signatureMatches(body, sign(now, body, 'other'), secret, now)).toBe(false);
    expect(signatureMatches(body, sign(now - 600), secret, now)).toBe(false);
    expect(signatureMatches(body, undefined, secret, now)).toBe(false);
    expect(signatureMatches(body, 'ts=abc;h1=00', secret, now)).toBe(false);
  });
});
