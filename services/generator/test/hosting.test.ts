import { describe, expect, it } from 'vitest';
import { refreshPreview } from '../src/core/drafts';
import { RetryLater } from '../src/core/domains';
import { hostingView, removeHosting, runHostingSetup, tenantName, TenantTaken, type Dns, type DnsRecord, type HostingDeps, type Tenant, type Tenants } from '../src/core/hosting';
import type { Email } from '../src/core/mail';
import { handleEvent, type PaymentDeps } from '../src/core/payments';
import { memoryStores } from './memory-stores';

const NOW = 1_800_000_000_000;
const ENDPOINT = 'd111.cloudfront.net';

function fakeDns() {
  let next = 1;
  // A new Porkbun domain parks itself on pixie.porkbun.com.
  const records: DnsRecord[] = [
    { id: String(next++), name: 'sol.com', type: 'ALIAS', content: 'pixie.porkbun.com' },
    { id: String(next++), name: '*.sol.com', type: 'CNAME', content: 'pixie.porkbun.com' },
    { id: String(next++), name: 'sol.com', type: 'MX', content: 'mail.example' },
  ];
  const dns: Dns = {
    list: async () => records.map((r) => ({ ...r })),
    async create(domain, { name, type, content }) {
      const full = name ? `${name}.${domain}` : domain;
      if (!records.some((r) => r.name === full && r.type === type && r.content === content)) records.push({ id: String(next++), name: full, type, content });
    },
    async remove(_domain, id) {
      records.splice(records.findIndex((r) => r.id === id), 1);
    },
  };
  return { dns, records };
}

function fakeTenants() {
  const all = new Map<string, Tenant>();
  const cert = { status: 'pending-validation' as string | undefined, requests: 0, arn: 'arn:cert/1' };
  const tenants: Tenants = {
    async create({ name, domains }) {
      if ([...all.values()].some((t) => t.domains.some((d) => domains.includes(d.domain)))) throw new TenantTaken('CNAMEAlreadyExists');
      const id = `dt_${all.size + 1}`;
      all.set(id, { id, name, domains: domains.map((domain) => ({ domain, status: 'inactive' })) });
      cert.requests++;
      return id;
    },
    get: async (id) => structuredClone(all.get(id) ?? [...all.values()].find((t) => t.name === id)),
    certificate: async () => ({ status: cert.status, arn: cert.arn }),
    async useCertificate(id, arn) {
      const t = all.get(id)!;
      t.certificateArn = arn;
      // CloudFront turns the domains on once an issued certificate is attached.
      if (cert.status === 'issued') for (const d of t.domains) d.status = 'active';
    },
    async requestCertificate() {
      cert.requests++;
      cert.status = 'pending-validation';
    },
    async remove(id) {
      all.delete(id);
    },
  };
  const issue = () => {
    cert.status = 'issued';
  };
  return { tenants, all, cert, issue };
}

function setup() {
  const memory = memoryStores();
  memory.sites.set('luna', {
    slug: 'luna', status: 'draft', jobId: 'j', createdAt: NOW, currentDraftId: 'd1', previewId: 'p1', domain: 'sol.com',
    billing: { subscriptionId: 'sub_1', customerId: 'ctm_1', status: 'active', updatedAt: NOW },
  });
  memory.domains.set('sol.com', { domain: 'sol.com', slug: 'luna', status: 'registered', createdAt: NOW, priceCents: 1108, ownerEmail: 'ana@luna.test', hosting: { step: 'publish', at: NOW } });
  const answers = { businessName: 'Panadería Luna', about: 'Pan de masa madre en Montevideo', contact: { whatsapp: '59894231234' }, lang: 'es' };
  memory.objects.set('_src/luna/d1.json', JSON.stringify({ answers, notes: [], page: '<html>v1</html>' }));
  memory.objects.set('_draft/d1/index.html', '<html>v1</html>');
  memory.objects.set('_draft/d1/assets/a.png', 'png');
  memory.objects.set('_errors/404.html', '<html>404</html>');
  const dns = fakeDns();
  const tenants = fakeTenants();
  const emails: Email[] = [];
  const deps: HostingDeps = { stores: memory.stores, dns: dns.dns, tenants: tenants.tenants, routingEndpoint: ENDPOINT, sendEmail: async (email) => void emails.push(email), appUrl: 'https://app.test', now: () => NOW };
  const record = () => memory.domains.get('sol.com')!;
  return { ...memory, ...dns, ...tenants, deps, record, emails };
}

describe('hosting setup', () => {
  it('publishes, points the DNS, makes the tenant, then waits for the certificate', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    // The live copy, with our 404 page.
    expect(t.objects.get('_live/luna/index.html')).toBe('<html>v1</html>');
    expect(t.objects.has('_live/luna/assets/a.png')).toBe(true);
    expect(t.objects.has('_live/luna/404.html')).toBe(true);
    expect(t.sites.get('luna')!.status).toBe('published');
    // Porkbun's parking records at the apex gave way; other records (mail, the wildcard) stay.
    expect(t.records.map((r) => `${r.name} ${r.type} ${r.content}`).sort()).toEqual([
      '*.sol.com CNAME pixie.porkbun.com',
      '_cf-challenge.sol.com TXT d111.cloudfront.net',
      'sol.com ALIAS d111.cloudfront.net',
      'sol.com MX mail.example',
      'www.sol.com CNAME d111.cloudfront.net',
    ]);
    expect([...t.all.values()]).toEqual([{ id: 'dt_1', name: tenantName('luna'), domains: [{ domain: 'sol.com', status: 'inactive' }, { domain: 'www.sol.com', status: 'inactive' }] }]);
    expect(t.record().hosting).toMatchObject({ step: 'cert', tenantId: 'dt_1' });
    expect(hostingView(t.record())).toBe('setting_up');

    t.issue();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater); // attaches the certificate
    expect(t.all.get('dt_1')!.certificateArn).toBe('arn:cert/1');
    expect(await runHostingSetup('luna', t.deps)).toBe('live');
    expect(t.record().hosting).toMatchObject({ step: 'live', liveAt: NOW });
    expect(hostingView(t.record())).toBe('live');
    expect(await runHostingSetup('luna', t.deps)).toBe('live'); // a redelivered message changes nothing
    expect(t.all.size).toBe(1);
  });

  it('emails the owner once, when the site is live on its domain', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    t.issue();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    expect(t.emails).toEqual([]); // not before it is live
    expect(await runHostingSetup('luna', t.deps)).toBe('live');
    expect(await runHostingSetup('luna', t.deps)).toBe('live');
    expect(t.emails).toHaveLength(1);
    const [email] = t.emails;
    expect(email).toMatchObject({ to: 'ana@luna.test', subject: 'Tu página web ya está en línea: Panadería Luna' });
    // A Uruguayan number: vos. The live address, with no expiry line.
    expect(email!.text).toContain('ya está en línea en www.sol.com. Compartila con tus clientes.');
    expect(email!.text).toContain('Abrir mi página web: https://www.sol.com/');
    expect(email!.text).not.toContain('durante una hora');
  });

  it('a failed email leaves the site live', async () => {
    const t = setup();
    t.deps.sendEmail = async () => {
      throw new Error('SES down');
    };
    t.issue();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater); // attaches the certificate
    expect(await runHostingSetup('luna', t.deps)).toBe('live');
    expect(t.record().hosting).toMatchObject({ step: 'live' });
  });

  it('each step is safe to repeat: a redelivery after the tenant was made adopts it', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    t.domains.set('sol.com', { ...t.record(), hosting: { step: 'dns', at: NOW } }); // as if cut off after create
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    expect(t.all.size).toBe(1);
    expect(t.record().hosting).toMatchObject({ step: 'cert', tenantId: 'dt_1' });
    expect(t.records.filter((r) => r.content === ENDPOINT)).toHaveLength(3);
  });

  it('a domain on someone else\'s tenant fails for good (and alarms)', async () => {
    const t = setup();
    t.all.set('dt_9', { id: 'dt_9', name: 'other', domains: [{ domain: 'sol.com' }] });
    expect(await runHostingSetup('luna', t.deps)).toBe('failed');
    expect(t.record().hosting).toMatchObject({ failed: 'domain_in_use' });
    expect(hostingView(t.record())).toBe('failed');
    expect(await runHostingSetup('luna', t.deps)).toBe('failed');
  });

  it('a timed-out certificate is requested once more, then fails', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    t.cert.status = 'validation-timed-out';
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    expect(t.cert.requests).toBe(2);
    t.cert.status = 'validation-timed-out';
    expect(await runHostingSetup('luna', t.deps)).toBe('failed');
    expect(t.record().hosting?.failed).toBe('certificate_validation-timed-out');
  });

  it('does nothing without a paid plan or a registered domain', async () => {
    const t = setup();
    t.sites.set('luna', { ...t.sites.get('luna')!, billing: { subscriptionId: 's', customerId: 'c', status: 'canceled', updatedAt: NOW } });
    expect(await runHostingSetup('luna', t.deps)).toBe('none');
    expect(t.objects.has('_live/luna/index.html')).toBe(false);
    expect(await runHostingSetup('nobody', t.deps)).toBe('none');
  });

  it('removeHosting (domain-detach) deletes the tenant and only our DNS records', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    await removeHosting(t.record(), t.deps);
    expect(t.all.size).toBe(0);
    expect(t.records.map((r) => r.name).sort()).toEqual(['*.sol.com', 'sol.com']);
  });
});

describe('a published site', () => {
  it('follows every change; a draft site does not', async () => {
    const t = setup();
    t.objects.set('_draft/d2/index.html', '<html>v2</html>');
    await refreshPreview('luna', 'd2', { stores: t.stores });
    expect(t.objects.has('_live/luna/index.html')).toBe(false);

    t.sites.set('luna', { ...t.sites.get('luna')!, status: 'published' });
    await refreshPreview('luna', 'd2', { stores: t.stores });
    expect(t.objects.get('_live/luna/index.html')).toBe('<html>v2</html>');
  });

  it('goes offline when the plan ends, and back when it is paid again', async () => {
    const t = setup();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    t.issue();
    await expect(runHostingSetup('luna', t.deps)).rejects.toBeInstanceOf(RetryLater);
    expect(await runHostingSetup('luna', t.deps)).toBe('live');
    const deps: PaymentDeps = { stores: t.stores, payments: {} as PaymentDeps['payments'], designsPriceId: 'pri_d', hostingPriceId: 'pri_h', now: () => NOW };
    const event = (status: string, at: string) => ({
      event_type: 'subscription.updated',
      occurred_at: at,
      data: { id: 'sub_1', status, customer_id: 'ctm_1', custom_data: { app: 'coyote', kind: 'hosting', slug: 'luna' }, items: [{ price: { id: 'pri_h' } }] },
    });
    t.objects.set('_errors/unavailable.html', '<html>no disponible</html>');
    await handleEvent(event('canceled', '2027-02-01T00:00:00Z'), deps);
    expect(t.objects.has('_live/luna/index.html')).toBe(false);
    expect(t.objects.get('_live/luna/404.html')).toBe('<html>no disponible</html>'); // every path on the domain
    expect(t.sites.get('luna')!.status).toBe('draft');
    await handleEvent(event('active', '2027-02-02T00:00:00Z'), deps);
    expect(t.objects.get('_live/luna/index.html')).toBe('<html>v1</html>');
    expect(t.sites.get('luna')!.status).toBe('published');
  });
});
