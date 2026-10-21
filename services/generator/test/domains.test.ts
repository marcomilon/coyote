import { describe, expect, it } from 'vitest';
import { attachDomain, checkDomains, domainIdeas, domainPage, normalizeQuery, REGISTRATIONS_PER_DAY, registerDomain, RegistrarError, RetryLater, runDomainOrder, type DomainDeps, type Quote, type Registrar } from '../src/core/domains';
import { deleteSite } from '../src/core/owner';
import { INVITED } from '../src/core/plan';
import { harness, NOW } from './harness';

/** A registrar in memory: names in `taken` are taken, `.co` is unanswered, everything else is available. */
function fakeRegistrar() {
  const owned = new Map<string, { autoRenew: boolean }>();
  const calls: string[] = [];
  const fail = { register: undefined as RegistrarError | undefined, setup: false };
  const taken = new Set(['luna.com']);
  const registrar: Registrar = {
    async check(domains) {
      calls.push(`check ${domains.join(',')}`);
      return domains.filter((d) => !d.endsWith('.co')).map((domain): Quote => (taken.has(domain) || owned.has(domain) ? { domain, status: 'taken' } : { domain, status: 'available', priceCents: 1108 }));
    },
    async register(domain, cost) {
      calls.push(`register ${domain} ${cost}`);
      if (fail.register) throw fail.register;
      owned.set(domain, { autoRenew: true });
    },
    async setAutoRenew(domain, on) {
      if (fail.setup) throw new Error('registrar down');
      owned.get(domain)!.autoRenew = on;
    },
    get: async (domain) => (owned.has(domain) ? { expiresAt: NOW + 365 * 86400_000 } : undefined),
  };
  return { registrar, owned, calls, fail };
}

const plan = (status: string) => ({ subscriptionId: 'sub_1', customerId: 'ctm_1', status, updatedAt: NOW });

function setup(open = true, billing: string | null = 'active') {
  const t = harness();
  const fake = fakeRegistrar();
  t.sites.set('luna', { slug: 'luna', status: 'draft', jobId: 'job-0', createdAt: NOW, ownerWhatsApp: '+525512345678' });
  void t.stores.linkAccountSite('e1', 'luna@example.com', 'es', { slug: 'luna', businessName: 'Luna', createdAt: NOW });
  t.sites.set('luna', { ...t.sites.get('luna')!, ownerEmailId: 'e1', ...(billing && { billing: plan(billing) }) });
  let now = NOW;
  const deps: DomainDeps = { stores: t.stores, registrar: fake.registrar, registerOpen: async () => open, now: () => now };
  const site = () => t.sites.get('luna')!;
  return { ...t, ...fake, deps, site, later: (ms: number) => (now += ms) };
}

describe('search', () => {
  it('reads what the owner typed as a label, with one of our TLDs at most', () => {
    expect(normalizeQuery('  Luna ')).toEqual({ label: 'luna' });
    expect(normalizeQuery('https://www.luna.com/')).toEqual({ label: 'luna', tld: 'com' });
    for (const bad of ['', '-luna', 'luna-', 'lu na', 'luna.net', 'luna.com.mx', 'luna.co', 'xn--lna-4ka', 'ñandú', 'a'.repeat(64)]) expect(normalizeQuery(bad), bad).toBeUndefined();
  });

  it('suggests names without "-": the business name joined, then with endings', () => {
    expect(domainIdeas('Panadería de la Luna')).toEqual(['panaderialuna', 'panaderiadelaluna', 'panaderialunaonline', 'panaderialunaweb', 'panaderialunaoficial']);
    expect(domainIdeas('Café & Té')).toEqual(['cafete', 'cafeteonline', 'cafeteweb', 'cafeteoficial']);
    expect(domainIdeas('!!')).toEqual([]);
  });

  it('opens the tab with up to 3 suggestions, free ones first, in one registry check', async () => {
    const t = setup();
    const page = await domainPage(t.site(), t.deps);
    expect(page.suggestions?.map((q) => q.domain)).toEqual(['lunaonline.com', 'lunaweb.com', 'lunaoficial.com']);
    expect(t.calls).toEqual(['check luna.com,lunaonline.com,lunaweb.com,lunaoficial.com']);
    t.registrar.check = async () => { throw new Error('registrar down'); };
    expect((await domainPage(t.site(), t.deps)).suggestions).toEqual([]);
  });

  it('checks .com; an unanswered name is unknown, not taken', async () => {
    const t = setup();
    expect(await checkDomains(t.site(), 'Luna.com', t.deps)).toEqual({ status: 200, quotes: [{ domain: 'luna.com', status: 'taken' }] });
    expect(await checkDomains(t.site(), 'sol', t.deps)).toEqual({ status: 200, quotes: [{ domain: 'sol.com', status: 'available', priceCents: 1108 }] });
    expect(t.calls).toEqual(['check luna.com', 'check sol.com']);
    for (const bad of ['luna.net', 'luna.mx']) expect(await checkDomains(t.site(), bad, t.deps), bad).toEqual({ status: 400 });
    const fake = fakeRegistrar();
    fake.registrar.check = async () => [];
    expect(await checkDomains(t.site(), 'sol', { ...t.deps, registrar: fake.registrar })).toMatchObject({ quotes: [{ domain: 'sol.com', status: 'unknown' }] });
  });

  it('caps checks per site per day', async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) await checkDomains(t.site(), 'luna', t.deps);
    expect(await checkDomains(t.site(), 'luna', t.deps)).toEqual({ status: 429 });
  });
});

describe('registering', () => {
  it('registers with only the domain from the owner, auto-renew off, and notes the account email', async () => {
    const t = setup();
    const result = await registerDomain(t.site(), { domain: 'Sol.com' }, t.deps);
    expect(result).toEqual({ status: 201, domain: { domain: 'sol.com', status: 'registered', expiresAt: NOW + 365 * 86400_000 } });
    expect(t.calls).toEqual(['check sol.com', 'register sol.com 1108']);
    expect(t.owned.get('sol.com')).toEqual({ autoRenew: false });
    expect(t.site().domain).toBe('sol.com');
    expect(t.domains.get('sol.com')).toMatchObject({ slug: 'luna', status: 'registered', ownerEmail: 'luna@example.com', priceCents: 1108 });
    expect(await registerDomain(t.site(), { domain: 'otra.com', contact: {} }, t.deps)).toEqual({ status: 400 }); // nothing else is taken
  });

  it('refuses while the switch is off, with nothing asked of the registrar', async () => {
    const t = setup(false);
    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toEqual({ status: 403 });
    expect(t.calls).toEqual([]);
  });

  it('refuses a TLD the site is not offered, a taken name, and a second domain', async () => {
    const t = setup();
    for (const domain of ['luna.net', 'luna.com.mx']) expect(await registerDomain(t.site(), { domain }, t.deps), domain).toEqual({ status: 400 });
    expect(await registerDomain(t.site(), { domain: 'luna.com' }, t.deps)).toEqual({ status: 409, error: 'not_available' });
    expect(t.calls.filter((c) => c.startsWith('register'))).toEqual([]);

    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toMatchObject({ status: 201 });
    expect(await registerDomain(t.site(), { domain: 'otra.com' }, t.deps)).toEqual({ status: 409, error: 'has_domain' });
  });

  it('caps registrations for the whole stack per day', async () => {
    const t = setup();
    for (let i = 0; i < REGISTRATIONS_PER_DAY; i++) {
      const slug = `site${i}`;
      t.sites.set(slug, { slug, status: 'draft', jobId: 'job-0', createdAt: NOW, billing: plan('active') });
      expect(await registerDomain(t.sites.get(slug)!, { domain: `${slug}.com` }, t.deps)).toMatchObject({ status: 201 });
    }
    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toEqual({ status: 429 });
    expect(t.site().domain).toBeUndefined();
    expect(t.domains.has('sol.com')).toBe(false);
  });

  it('frees the claim when the registrar refuses, and says when the price changed', async () => {
    const t = setup();
    t.fail.register = new RegistrarError('COST_MISMATCH', 'price changed');
    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toEqual({ status: 409, error: 'price_changed' });
    t.fail.register = new RegistrarError('INSUFFICIENT_FUNDS', 'no credit');
    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toEqual({ status: 502 });
    expect(t.site().domain).toBeUndefined();
    expect(t.domains.size).toBe(0);
  });

  it('finishes the setup on the next visit when the registrar failed after charging', async () => {
    const t = setup();
    t.fail.setup = true;
    expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toMatchObject({ status: 201, domain: { status: 'pending' } });
    expect(t.domains.get('sol.com')).toMatchObject({ status: 'setup_pending' });

    t.fail.setup = false;
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ domain: 'sol.com', status: 'registered' });
    expect(t.owned.get('sol.com')).toEqual({ autoRenew: false });
  });

  it('recovers a registration that was cut off: finished if the registrar has it, freed if not', async () => {
    const t = setup();
    await t.stores.claimDomain({ domain: 'sol.com', slug: 'luna', status: 'registering', createdAt: NOW, priceCents: 1108, ownerEmail: 'luna@example.com' });
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ status: 'registering' }); // still within the request's time
    t.later(5 * 60_000);
    expect((await domainPage(t.site(), t.deps)).domain).toBeUndefined();
    expect(t.site().domain).toBeUndefined();

    await t.stores.claimDomain({ domain: 'sol.com', slug: 'luna', status: 'registering', createdAt: NOW, priceCents: 1108, ownerEmail: 'luna@example.com' });
    t.owned.set('sol.com', { autoRenew: true });
    expect((await domainPage(t.site(), t.deps)).domain).toMatchObject({ status: 'registered' });
    expect(t.owned.get('sol.com')!.autoRenew).toBe(false);
  });
});

describe('the monthly plan', () => {
  it('registering needs it, with nothing asked of the registrar', async () => {
    for (const billing of [null, 'canceled', 'paused']) {
      const t = setup(true, billing);
      expect(await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).toEqual({ status: 402 });
      expect(t.calls).toEqual([]);
    }
  });

  it('a card Paddle is still retrying (past_due) may register', async () => {
    const t = setup(true, 'past_due');
    expect((await registerDomain(t.site(), { domain: 'sol.com' }, t.deps)).status).toBe(201);
  });
});

describe('a paid domain order', () => {
  function ordered(domain = 'sol.com') {
    const t = setup();
    t.sites.set('luna', { ...t.site(), domainOrder: { domain, at: NOW } });
    return t;
  }

  it('registers the domain and clears the order; the tab follows it', async () => {
    const t = ordered();
    expect(await domainPage(t.site(), t.deps)).toMatchObject({ order: { domain: 'sol.com' } });
    expect(await runDomainOrder('luna', t.deps)).toBe('registered');
    expect(t.site()).toMatchObject({ domain: 'sol.com', domainOrder: undefined });
    expect(await domainPage(t.site(), t.deps)).toMatchObject({ domain: { domain: 'sol.com', status: 'registered' } });
    expect(await runDomainOrder('luna', t.deps)).toBe('none'); // a redelivered message does nothing
    expect(t.calls.filter((c) => c.startsWith('register'))).toEqual(['register sol.com 1108']);
  });

  it('throws to be retried while the registrar is down, and leaves nothing claimed', async () => {
    const t = ordered();
    t.fail.register = new RegistrarError('ERROR', 'down');
    await expect(runDomainOrder('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    expect(t.site()).toMatchObject({ domain: undefined, domainOrder: { domain: 'sol.com' } });
    t.fail.register = undefined;
    expect(await runDomainOrder('luna', t.deps)).toBe('registered');
  });

  it('a name taken meanwhile is a failure retrying cannot fix: kept on the order, shown on the tab', async () => {
    const t = ordered('luna.com');
    expect(await runDomainOrder('luna', t.deps)).toBe('failed');
    expect(t.site().domainOrder).toEqual({ domain: 'luna.com', at: NOW, failed: 'not_available' });
    expect(await domainPage(t.site(), t.deps)).toMatchObject({ order: { domain: 'luna.com', failed: true } });
    expect(await runDomainOrder('luna', t.deps)).toBe('none');
  });
});

describe('attaching a domain we already own (testing)', () => {
  it('ends as a paid registration does: account email, auto-renew off, expiry, order cleared, hosting queued', async () => {
    const t = setup();
    const queued: string[] = [];
    const deps = { ...t.deps, queueHosting: async (slug: string, domain: string) => void queued.push(`${slug} ${domain}`) };
    t.owned.set('sol.com', { autoRenew: true });
    t.sites.set('luna', { ...t.site(), domainOrder: { domain: 'otra.com', at: NOW } });
    expect(await attachDomain(t.site(), 'sol.com', deps)).toEqual({ status: 201, domain: { domain: 'sol.com', status: 'registered', expiresAt: NOW + 365 * 86400_000 } });
    expect(t.owned.get('sol.com')).toEqual({ autoRenew: false });
    expect(t.domains.get('sol.com')).toMatchObject({ slug: 'luna', status: 'registered', ownerEmail: 'luna@example.com', hosting: { step: 'publish' } });
    expect(t.site()).toMatchObject({ domain: 'sol.com', domainOrder: undefined });
    expect(queued).toEqual(['luna sol.com']);
    expect(t.calls.filter((c) => c.startsWith('register'))).toEqual([]); // nothing bought
    expect((await domainPage(t.site(), deps)).invited).toBeUndefined(); // a Paddle plan keeps its portal
    t.sites.set('luna', { ...t.site(), billing: { subscriptionId: INVITED, customerId: INVITED, status: 'active', updatedAt: NOW } });
    expect(await domainPage(t.site(), deps)).toMatchObject({ plan: 'active', invited: true });
  });

  it('refuses a domain not in our account, a second domain, and one linked elsewhere', async () => {
    const t = setup();
    expect(await attachDomain(t.site(), 'sol.com', t.deps)).toEqual({ status: 404 });
    expect(await attachDomain(t.site(), 'sol.net', t.deps)).toEqual({ status: 400 });
    t.owned.set('sol.com', { autoRenew: true });
    t.owned.set('mar.com', { autoRenew: true });
    expect((await attachDomain(t.site(), 'sol.com', t.deps)).status).toBe(201);
    expect(await attachDomain(t.site(), 'mar.com', t.deps)).toEqual({ status: 409, error: 'has_domain' });
    t.sites.set('sol', { slug: 'sol', status: 'draft', jobId: 'job-1', createdAt: NOW });
    expect(await attachDomain(t.sites.get('sol')!, 'sol.com', t.deps)).toEqual({ status: 409, error: 'not_available' });
  });
});

describe('Dominio tab', () => {
  it('shows whether registering is open, and the plan', async () => {
    expect(await domainPage(setup(false).site(), setup(false).deps)).toMatchObject({ registerOpen: false, plan: 'active' });
    const t = setup(true, null);
    expect(await domainPage(t.site(), t.deps)).toMatchObject({ registerOpen: true, plan: 'none' });
  });

  it('keeps the domain row when the site is deleted (the domain stays registered)', async () => {
    const t = setup();
    await registerDomain(t.site(), { domain: 'sol.com' }, t.deps);
    await deleteSite(t.site(), t.ownerDeps);
    expect(t.sites.has('luna')).toBe(false);
    expect(t.domains.get('sol.com')).toMatchObject({ slug: 'luna', status: 'registered' });
  });
});
