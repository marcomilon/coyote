// Serving a site on its owner's domain, once the domain is registered and the plan is paid (paying publishes).
// One step at a time, each safe to repeat; the HostingSetups queue delivers it again until it is live:
//   publish: the current draft → `_live/<slug>/` (drafts.ts; later edits follow it)
//   dns:     at Porkbun, the apex ALIAS and `www` CNAME → the live connection group's routing endpoint
//   tenant:  a CloudFront distribution tenant for the domain (origin path `/_live/{{slug}}`) with a managed certificate
//   cert:    wait until CloudFront has validated it (over HTTP, through the records above) and the domains are active
// A step that has to wait throws RetryLater. One that can't succeed is kept as `hosting.failed` (we get an alert).
import { publishLive } from './drafts';
import { RetryLater } from './retry';
import type { DomainRecord, Hosting, Stores } from './jobs';
import { isSubscribed } from './plan';

export interface DnsRecord {
  id: string;
  /** The full name, as Porkbun lists it: `luna.com`, `www.luna.com`. */
  name: string;
  type: string;
  content: string;
}

/** The domain's DNS (aws/porkbun.ts). */
export interface Dns {
  list(domain: string): Promise<DnsRecord[]>;
  /** `name` is relative: '' for the apex. A record that already exists counts as created. */
  create(domain: string, record: { name: string; type: string; content: string }): Promise<void>;
  remove(domain: string, id: string): Promise<void>;
}

export interface Tenant {
  id: string;
  name: string;
  domains: { domain: string; status?: string }[];
}

/** CloudFront distribution tenants on the live distribution (aws/tenants.ts). */
export interface Tenants {
  /** Throws TenantTaken when one of the domains is already on another tenant. */
  create(input: { name: string; domains: string[]; slug: string }): Promise<string>;
  get(id: string): Promise<Tenant | undefined>;
  findByDomain(domain: string): Promise<Tenant | undefined>;
  /** The managed certificate's status: pending-validation, issued, validation-timed-out, failed, revoked… */
  certificate(id: string): Promise<string | undefined>;
  requestCertificate(id: string, domain: string): Promise<void>;
  /** Disables it, then deletes it once CloudFront allows (throws RetryLater meanwhile). */
  remove(id: string): Promise<void>;
}

export class TenantTaken extends Error {}

export interface HostingDeps {
  stores: Stores;
  dns: Dns;
  tenants: Tenants;
  /** The live connection group's routing endpoint (`dxxxx.cloudfront.net`): what owners' domains point at. */
  routingEndpoint: string;
  now(): number;
}

export const tenantName = (slug: string) => `site-${slug}`;
const WANTED = (endpoint: string) => [
  { name: '', type: 'ALIAS', content: endpoint },
  { name: 'www', type: 'CNAME', content: endpoint },
  // CloudFront asks for it when the domain reaches it through a flattened record (the apex ALIAS) rather than a CNAME.
  { name: '_cf-challenge', type: 'TXT', content: endpoint },
];
/** Record types that would answer for the apex or www instead of ours. */
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'ALIAS', 'CNAME']);
/** Certificate statuses that won't turn into `issued` by waiting. */
const CERT_DEAD = new Set(['validation-timed-out', 'failed', 'revoked', 'expired', 'inactive']);
const CERT_REQUESTS = 2;

export async function runHostingSetup(slug: string, deps: HostingDeps): Promise<'live' | 'failed' | 'none'> {
  const { stores } = deps;
  const site = await stores.getSite(slug);
  const record = site?.domain ? await stores.getDomain(site.domain) : undefined;
  if (!site || !record || record.status !== 'registered' || record.slug !== slug) return 'none';
  if (record.hosting?.failed) return 'failed';
  if (record.hosting?.step === 'live') return 'live';
  if (!isSubscribed(site)) return 'none'; // the plan ended meanwhile: paying again publishes (payments.ts)

  let hosting: Hosting = record.hosting ?? { step: 'publish', at: deps.now() };
  const save = async (patch: Partial<Hosting>) => {
    hosting = { ...hosting, ...patch, at: deps.now() };
    await stores.saveDomain({ domain: record.domain, hosting });
  };
  const fail = async (reason: string) => {
    await save({ failed: reason });
    return 'failed' as const;
  };

  for (;;) {
    switch (hosting.step) {
      case 'publish':
        await publishLive(site, stores);
        await save({ step: 'dns' });
        break;
      case 'dns':
        await pointDns(record, deps);
        await save({ step: 'tenant' });
        break;
      case 'tenant': {
        let tenantId: string;
        try {
          tenantId = await deps.tenants.create({ name: tenantName(slug), domains: [record.domain, `www.${record.domain}`], slug });
        } catch (error) {
          if (!(error instanceof TenantTaken)) throw error;
          // A redelivery after create succeeded, or someone else's tenant.
          const existing = await deps.tenants.findByDomain(record.domain);
          if (existing?.name !== tenantName(slug)) return fail('domain_in_use');
          tenantId = existing.id;
        }
        await save({ step: 'cert', tenantId, certRequests: hosting.certRequests ?? 1 });
        break;
      }
      case 'cert': {
        const status = await deps.tenants.certificate(hosting.tenantId!);
        if (status && CERT_DEAD.has(status)) {
          if ((hosting.certRequests ?? 1) >= CERT_REQUESTS) return fail(`certificate_${status}`);
          await deps.tenants.requestCertificate(hosting.tenantId!, record.domain);
          await save({ certRequests: (hosting.certRequests ?? 1) + 1 });
          throw new RetryLater(`hosting ${slug}: certificate ${status}, requested again`);
        }
        if (status !== 'issued') throw new RetryLater(`hosting ${slug}: certificate ${status ?? 'unknown'}`);
        const tenant = await deps.tenants.get(hosting.tenantId!);
        if (!tenant || tenant.domains.some((d) => d.status !== 'active')) throw new RetryLater(`hosting ${slug}: domains not active yet`);
        const now = deps.now();
        await save({ step: 'live', liveAt: now });
        return 'live';
      }
      case 'live':
        return 'live';
    }
  }
}

/** Our records at the apex, www and the challenge name, and nothing else answering for them (Porkbun's parking). */
async function pointDns(record: DomainRecord, deps: HostingDeps) {
  const { domain } = record;
  const wanted = WANTED(deps.routingEndpoint);
  const full = (name: string) => (name ? `${name}.${domain}` : domain);
  const existing = await deps.dns.list(domain);
  for (const r of existing) {
    const mine = wanted.find((w) => full(w.name) === r.name && w.type === r.type && w.content === r.content);
    const inTheWay = (r.name === domain || r.name === `www.${domain}`) && ADDRESS_TYPES.has(r.type);
    if (inTheWay && !mine) await deps.dns.remove(domain, r.id);
  }
  for (const w of wanted) {
    if (!existing.some((r) => r.name === full(w.name) && r.type === w.type && r.content === w.content)) await deps.dns.create(domain, w);
  }
}

/** Undoes the setup (domain-detach, for testing): the tenant, our DNS records. The live copy goes with takeDownLive. */
export async function removeHosting(record: DomainRecord, deps: HostingDeps): Promise<void> {
  const tenant = record.hosting?.tenantId ? await deps.tenants.get(record.hosting.tenantId) : await deps.tenants.findByDomain(record.domain);
  if (tenant) await deps.tenants.remove(tenant.id);
  const wanted = WANTED(deps.routingEndpoint);
  const full = (name: string) => (name ? `${name}.${record.domain}` : record.domain);
  for (const r of await deps.dns.list(record.domain)) {
    if (wanted.some((w) => full(w.name) === r.name && w.type === r.type && w.content === r.content)) await deps.dns.remove(record.domain, r.id);
  }
}

/** What the owner sees (GET /me/domain). */
export function hostingView(record: DomainRecord): 'setting_up' | 'live' | 'failed' | undefined {
  if (record.status !== 'registered' || !record.hosting) return undefined;
  if (record.hosting.failed) return 'failed';
  return record.hosting.step === 'live' ? 'live' : 'setting_up';
}
