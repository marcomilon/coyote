import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureMatches } from '../src/aws/paddle';
import { checkout, handleEvent, type PaymentDeps, type Payments } from '../src/core/payments';
import { boughtDesigns, paidWritesLeft } from '../src/core/paid-writes';
import type { SiteRecord } from '../src/core/jobs';
import { memoryStores } from './memory-stores';

const PRICE = 'pri_designs';
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
  };
  const deps: PaymentDeps = { stores, payments, designsPriceId: PRICE, pageTier: async () => tier, now: () => 1_700_000_000_000 };
  return { stores, made, deps };
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
    expect((await checkout(site, setup('free').deps)).status).toBe(409);
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
