import { describe, expect, it } from 'vitest';
import { GET as llms } from '../src/pages/llms.txt';
import { offers } from '../src/config/offers';
import { LOCAL_PRICES } from '../../services/generator/src/core/prices';

const site = new URL('https://example.test/');
const call = (route: typeof llms, s?: URL) => route({ site: s } as Parameters<typeof llms>[0]) as Response;

describe('llms.txt', () => {
  it('lists the prices and the public pages', async () => {
    const text = await call(llms, site).text();
    expect(text).toMatch(/^# ventas314\.com\n/);
    expect(text).toContain('| México | $179 | $89 |');
    expect(text).toContain('| Other countries | USD');
    expect(text).toContain('https://example.test/pt/criar');
  });

  it('is absent from a domainless build', () => {
    expect(call(llms).status).toBe(404);
  });
});

describe('offers', () => {
  const all = offers('es', false, 'https://example.test/#precio');

  it('has the free offer and each paid one per local-price country plus USD', () => {
    expect(all[0]).toMatchObject({ price: 0 });
    const paid = Object.keys(LOCAL_PRICES).length + 1;
    expect(all).toHaveLength(1 + 2 * paid);
    expect(all).toContainEqual(expect.objectContaining({ priceCurrency: 'MXN', price: 179, eligibleRegion: [{ '@type': 'Country', name: 'MX' }] }));
    expect(all).toContainEqual(expect.objectContaining({ priceCurrency: 'USD', price: 9.99, priceSpecification: expect.objectContaining({ billingDuration: 'P1M' }) }));
  });
});
