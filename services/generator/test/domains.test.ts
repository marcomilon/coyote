import { describe, expect, it } from 'vitest';
import { checkDomains, domainPage, normalizeQuery, REGISTRATIONS_PER_DAY, registerDomain, RegistrarError, type DomainDeps, type Quote, type RegistrantContact, type Registrar } from '../src/core/domains';
import { deleteSite } from '../src/core/owner';
import { harness, NOW } from './harness';

/** A registrar in memory: names in `taken` are taken, `.co` is unanswered, everything else is available. */
function fakeRegistrar() {
  const owned = new Map<string, { contact?: RegistrantContact; autoRenew: boolean }>();
  const calls: string[] = [];
  const fail = { register: undefined as RegistrarError | undefined, contacts: false };
  const taken = new Set(['luna.com']);
  const price = (domain: string) => (domain.endsWith('.mx') && !domain.endsWith('.com.mx') ? 3557 : 1108);
  const registrar: Registrar = {
    prices: async () => ({ com: { registration: 1108, renewal: 1108 }, 'com.mx': { registration: 1133, renewal: 2332 }, mx: { registration: 3557, renewal: 4123 }, co: { registration: 1576, renewal: 3120 } }),
    async check(domains) {
      calls.push(`check ${domains.join(',')}`);
      return domains.filter((d) => !d.endsWith('.co')).map((domain): Quote => (taken.has(domain) || owned.has(domain) ? { domain, status: 'taken' } : { domain, status: 'available', priceCents: price(domain) }));
    },
    async register(domain, cost) {
      calls.push(`register ${domain} ${cost}`);
      if (fail.register) throw fail.register;
      owned.set(domain, { autoRenew: true });
    },
    contactProblems: async (contact) => (contact.city === 'Narnia' ? ['city'] : []),
    async setContacts(domain, contact) {
      calls.push(`contacts ${domain}`);
      if (fail.contacts) throw new Error('registrar down');
      owned.get(domain)!.contact = contact;
    },
    async setAutoRenew(domain, on) {
      owned.get(domain)!.autoRenew = on;
    },
    get: async (domain) => (owned.has(domain) ? { expiresAt: NOW + 365 * 86400_000 } : undefined),
  };
  return { registrar, owned, calls, fail };
}

const contact = {
  firstName: 'Lucía',
  lastName: 'Pérez',
  email: 'Luna@Example.com',
  phone: '+525512345678',
  address: 'Av. Insurgentes 100',
  city: 'CDMX',
  state: 'Mexico City',
  postalCode: '06700',
  country: 'MX',
};

function setup(open = true) {
  const t = harness();
  const fake = fakeRegistrar();
  t.sites.set('luna', { slug: 'luna', status: 'draft', jobId: 'job-0', createdAt: NOW });
  let now = NOW;
  const deps: DomainDeps = { stores: t.stores, registrar: fake.registrar, registerOpen: async () => open, now: () => now };
  const site = () => t.sites.get('luna')!;
  return { ...t, ...fake, deps, site, later: (ms: number) => (now += ms) };
}

describe('search', () => {
  it('reads what the owner typed as a label, with one of our TLDs at most', () => {
    expect(normalizeQuery('  Luna ')).toEqual({ label: 'luna' });
    expect(normalizeQuery('https://www.luna.com.mx/')).toEqual({ label: 'luna', tld: 'com.mx' });
    for (const bad of ['', '-luna', 'luna-', 'lu na', 'luna.net', 'xn--lna-4ka', 'ñandú', 'a'.repeat(64)]) expect(normalizeQuery(bad), bad).toBeUndefined();
  });

  it('checks every TLD at once, or only the one typed; an unanswered name is unknown, not taken', async () => {
    const t = setup();
    expect(await checkDomains(t.site(), 'luna', t.deps)).toEqual({
      status: 200,
      quotes: [
        { domain: 'luna.com', status: 'taken' },
        { domain: 'luna.com.mx', status: 'available', priceCents: 1108 },
        { domain: 'luna.mx', status: 'available', priceCents: 3557 },
        { domain: 'luna.co', status: 'unknown' },
      ],
    });
    expect(t.calls).toEqual(['check luna.com,luna.com.mx,luna.mx,luna.co']);
    expect(await checkDomains(t.site(), 'luna.mx', t.deps)).toMatchObject({ quotes: [{ domain: 'luna.mx' }] });
    expect(await checkDomains(t.site(), 'luna.net', t.deps)).toEqual({ status: 400 });
  });

  it('caps checks per site per day', async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) await checkDomains(t.site(), 'luna', t.deps);
    expect(await checkDomains(t.site(), 'luna', t.deps)).toEqual({ status: 429 });
  });
});

describe('registering', () => {
  it('registers with the owner as contact, auto-renew off, and keeps the contact only until the registrar has it', async () => {
    const t = setup();
    const result = await registerDomain(t.site(), { domain: 'Luna.com.mx', contact }, t.deps);
    expect(result).toEqual({ status: 201, domain: { domain: 'luna.com.mx', status: 'registered', expiresAt: NOW + 365 * 86400_000 } });
    expect(t.calls).toContain('register luna.com.mx 1108');
    expect(t.owned.get('luna.com.mx')).toMatchObject({ contact: { email: 'luna@example.com', phone: '+525512345678' }, autoRenew: false });
    expect(t.site().domain).toBe('luna.com.mx');
    expect(t.domains.get('luna.com.mx')).toMatchObject({ slug: 'luna', status: 'registered', ownerEmail: 'luna@example.com', priceCents: 1108 });
    expect(t.domains.get('luna.com.mx')!.contact).toBeUndefined();
  });

  it('refuses while the switch is off, with nothing asked of the registrar', async () => {
    const t = setup(false);
    expect(await registerDomain(t.site(), { domain: 'luna.com.mx', contact }, t.deps)).toEqual({ status: 403 });
    expect(t.calls).toEqual([]);
  });

  it('refuses a bad contact, a TLD we do not sell, a taken name, and a second domain', async () => {
    const t = setup();
    expect(await registerDomain(t.site(), { domain: 'luna.com.mx', contact: { ...contact, state: 'Ciudad de México' } }, t.deps)).toEqual({ status: 400, fields: ['state'] }); // the registrar spells the states its way (regions.ts)
    expect(await registerDomain(t.site(), { domain: 'luna.com.mx', contact: { ...contact, phone: '+5255' } }, t.deps)).toEqual({ status: 400, fields: ['phone'] });
    expect(await registerDomain(t.site(), { domain: 'luna.com.mx', contact: { ...contact, country: 'CO', phone: '+573001234567', state: 'Bogotá D.C.', city: 'Narnia' } }, t.deps)).toEqual({ status: 400, fields: ['city'] }); // the registrar's own check, before any charge
    expect(await registerDomain(t.site(), { domain: 'luna.net', contact }, t.deps)).toEqual({ status: 400, fields: ['domain'] });
    expect(await registerDomain(t.site(), { domain: 'luna.com', contact }, t.deps)).toEqual({ status: 409, error: 'not_available' });
    expect(t.calls.filter((c) => c.startsWith('register'))).toEqual([]);

    expect(await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps)).toMatchObject({ status: 201 });
    expect(await registerDomain(t.site(), { domain: 'luna.com.mx', contact }, t.deps)).toEqual({ status: 409, error: 'has_domain' });
  });

  it('caps registrations for the whole stack per day', async () => {
    const t = setup();
    for (let i = 0; i < REGISTRATIONS_PER_DAY; i++) {
      const slug = `site${i}`;
      t.sites.set(slug, { slug, status: 'draft', jobId: 'job-0', createdAt: NOW });
      expect(await registerDomain(t.sites.get(slug)!, { domain: `${slug}.com`, contact }, t.deps)).toMatchObject({ status: 201 });
    }
    expect(await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps)).toEqual({ status: 429 });
    expect(t.site().domain).toBeUndefined();
    expect(t.domains.has('luna.mx')).toBe(false);
  });

  it('frees the claim when the registrar refuses, and says when the price changed', async () => {
    const t = setup();
    t.fail.register = new RegistrarError('COST_MISMATCH', 'price changed');
    expect(await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps)).toEqual({ status: 409, error: 'price_changed' });
    t.fail.register = new RegistrarError('INSUFFICIENT_FUNDS', 'no credit');
    expect(await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps)).toEqual({ status: 502 });
    expect(t.site().domain).toBeUndefined();
    expect(t.domains.size).toBe(0);
  });

  it('finishes the contact setup on the next visit when the registrar failed after charging', async () => {
    const t = setup();
    t.fail.contacts = true;
    expect(await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps)).toMatchObject({ status: 201, domain: { status: 'pending' } });
    expect(t.domains.get('luna.mx')).toMatchObject({ status: 'contacts_pending', contact: { firstName: 'Lucía' } });

    t.fail.contacts = false;
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ domain: 'luna.mx', status: 'registered' });
    expect(t.owned.get('luna.mx')).toMatchObject({ contact: { firstName: 'Lucía' }, autoRenew: false });
    expect(t.domains.get('luna.mx')!.contact).toBeUndefined();
  });

  it('recovers a registration that was cut off: finished if the registrar has it, freed if not', async () => {
    const t = setup();
    await t.stores.claimDomain({ domain: 'luna.mx', slug: 'luna', status: 'registering', createdAt: NOW, priceCents: 3557, ownerEmail: 'luna@example.com', contact: { ...contact, email: 'luna@example.com' } });
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ status: 'registering' }); // still within the request's time
    t.later(5 * 60_000);
    expect((await domainPage(t.site(), t.deps)).domain).toBeUndefined();
    expect(t.site().domain).toBeUndefined();

    await t.stores.claimDomain({ domain: 'luna.mx', slug: 'luna', status: 'registering', createdAt: NOW, priceCents: 3557, ownerEmail: 'luna@example.com', contact: { ...contact, email: 'luna@example.com' } });
    t.owned.set('luna.mx', { autoRenew: true });
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ status: 'registered' });
    expect(t.owned.get('luna.mx')!.autoRenew).toBe(false);
  });
});

describe('Dominio tab', () => {
  it('shows the prices, whether registering is open, and the account email to prefill', async () => {
    const t = setup(false);
    await t.stores.linkAccountSite('e1', 'luna@example.com', 'es', { slug: 'luna', businessName: 'Luna', createdAt: NOW });
    t.sites.set('luna', { ...t.site(), ownerEmailId: 'e1' });
    expect(await domainPage(t.site(), t.deps)).toEqual({
      domain: undefined,
      registerOpen: false,
      email: 'luna@example.com',
      tlds: [
        { tld: 'com', priceCents: 1108, renewalCents: 1108 },
        { tld: 'com.mx', priceCents: 1133, renewalCents: 2332 },
        { tld: 'mx', priceCents: 3557, renewalCents: 4123 },
        { tld: 'co', priceCents: 1576, renewalCents: 3120 },
      ],
    });
  });

  it('keeps the domain row when the site is deleted (the domain stays registered)', async () => {
    const t = setup();
    await registerDomain(t.site(), { domain: 'luna.mx', contact }, t.deps);
    await deleteSite(t.site(), t.ownerDeps);
    expect(t.sites.has('luna')).toBe(false);
    expect(t.domains.get('luna.mx')).toMatchObject({ slug: 'luna', status: 'registered' });
  });
});
