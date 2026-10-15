// The site's own domain (Mi sitio → Dominio): search names, register one per site. Coyote is the registrant (our
// Porkbun account's contact, verified once), so the owner fills in nothing; on request we move a domain to the owner.
// The registrar is behind `Registrar` (aws/porkbun.ts). Coyote pays for now, so registering only works while the
// `./coyote.sh domain-register` switch is on, and a daily cap limits it. Pointing the domain at the site waits for publishing.
import { z } from 'zod';
import type { DomainRecord, SiteRecord, Stores } from './jobs';
import { day, inTwoDays } from './owner';

/** The TLDs offered: `.com` only for now (WHOIS privacy everywhere; the local ones Porkbun sells are `.com.mx`, `.mx`, `.co`). */
export const TLDS = ['com'] as const;
export type Tld = (typeof TLDS)[number];

/** Availability checks per site per day (each one asks the registry about every TLD). */
export const CHECKS_PER_DAY = 100;
/** Registrations per day for the whole stack, while Coyote pays. */
export const REGISTRATIONS_PER_DAY = 3;
/** A registration still `registering` after this long was cut off: GET asks the registrar how it ended. */
const STUCK_MS = 2 * 60 * 1000;

export interface Quote {
  domain: string;
  status: 'available' | 'taken' | 'unknown';
  /** First-year price in US cents (the registration's cost check; the search list doesn't show it). */
  priceCents?: number;
}

export interface Registrar {
  check(domains: string[]): Promise<Quote[]>;
  /** Registers for the TLD's minimum term, with our account's contact. `cost` must equal the current quote. Safe to retry with the same key. */
  register(domain: string, costCents: number, idempotencyKey: string): Promise<void>;
  setAutoRenew(domain: string, on: boolean): Promise<void>;
  /** The domain if it is in our registrar account. */
  get(domain: string): Promise<{ expiresAt?: number } | undefined>;
}

export interface DomainDeps {
  stores: Stores;
  registrar: Registrar;
  /** The `./coyote.sh domain-register` switch. */
  registerOpen(): Promise<boolean>;
  now(): number;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What the owner typed → the label and, if they typed one we sell, the TLD. Undefined when it can't be a domain. */
export function normalizeQuery(query: string): { label: string; tld?: Tld } | undefined {
  const value = query.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const dot = value.indexOf('.');
  const label = dot === -1 ? value : value.slice(0, dot);
  const rest = dot === -1 ? undefined : value.slice(dot + 1);
  if (!LABEL.test(label) || label.slice(2, 4) === '--') return undefined; // "xn--" names: IDNs are not offered
  if (rest === undefined || rest === '') return { label };
  return (TLDS as readonly string[]).includes(rest) ? { label, tld: rest as Tld } : undefined;
}

export const tldOf = (domain: string): Tld | undefined => TLDS.find((tld) => domain.endsWith(`.${tld}`) && LABEL.test(domain.slice(0, -tld.length - 1)));

/** Availability of the name under every TLD, or only the one typed. */
export async function checkDomains(site: SiteRecord, query: string, deps: Pick<DomainDeps, 'stores' | 'registrar' | 'now'>): Promise<{ status: 200; quotes: Quote[] } | { status: 400 | 429 }> {
  const name = normalizeQuery(query);
  if (!name) return { status: 400 };
  if (!(await deps.stores.hitRateLimit(`domain-check#${site.slug}#${day(deps.now())}`, CHECKS_PER_DAY, inTwoDays(deps.now())))) return { status: 429 };
  const domains = (name.tld ? [name.tld] : TLDS).map((tld) => `${name.label}.${tld}`);
  const quotes = await deps.registrar.check(domains);
  return { status: 200, quotes: domains.map((domain) => quotes.find((q) => q.domain === domain) ?? { domain, status: 'unknown' }) };
}

const RegisterBody = z.object({ domain: z.string().max(80) }).strict();

export type RegisterResult =
  | { status: 201; domain: DomainView }
  | { status: 400 }
  | { status: 403 | 429 }
  | { status: 409; error: 'has_domain' | 'not_available' | 'price_changed' }
  | { status: 502 };

/**
 * Registers the domain for the site: fresh quote → claim (one domain per site, one site per domain) → register →
 * auto-renew off. A failure after the registrar charged leaves `setup_pending`, which GET retries.
 */
export async function registerDomain(site: SiteRecord, input: unknown, deps: DomainDeps): Promise<RegisterResult> {
  if (!(await deps.registerOpen())) return { status: 403 };
  const parsed = RegisterBody.safeParse(input);
  if (!parsed.success) return { status: 400 };
  const domain = parsed.data.domain.trim().toLowerCase();
  if (!tldOf(domain)) return { status: 400 };
  if (site.domain) return { status: 409, error: 'has_domain' };

  const [quote] = await deps.registrar.check([domain]);
  if (quote?.status !== 'available' || !quote.priceCents) return { status: 409, error: 'not_available' };
  const now = deps.now();
  // The owner's email, to reach them about the domain (a transfer to their name, the renewal).
  const ownerEmail = site.ownerEmailId ? (await deps.stores.getAccount(site.ownerEmailId))?.email : undefined;
  const record: DomainRecord = { domain, slug: site.slug, status: 'registering', createdAt: now, priceCents: quote.priceCents, ownerEmail };
  if (!(await deps.stores.claimDomain(record))) return { status: 409, error: 'not_available' };
  if (!(await deps.stores.hitRateLimit(`domain-register#${day(now)}`, REGISTRATIONS_PER_DAY, inTwoDays(now)))) {
    await deps.stores.releaseDomain(domain, site.slug);
    return { status: 429 };
  }

  try {
    await deps.registrar.register(domain, quote.priceCents, `${site.slug}:${domain}:${now}`);
  } catch (error) {
    console.error('register failed', domain, error);
    await deps.stores.releaseDomain(domain, site.slug);
    return error instanceof RegistrarError && error.code === 'COST_MISMATCH' ? { status: 409, error: 'price_changed' } : { status: 502 };
  }
  await deps.stores.saveDomain({ domain, status: 'setup_pending', registeredAt: now });
  return { status: 201, domain: domainView(await finishSetup((await deps.stores.getDomain(domain))!, deps)) };
}

/** Auto-renew off, expiry noted. Leaves `setup_pending` if the registrar fails; GET retries. */
async function finishSetup(record: DomainRecord, deps: Pick<DomainDeps, 'stores' | 'registrar'>): Promise<DomainRecord> {
  try {
    await deps.registrar.setAutoRenew(record.domain, false);
    const details = await deps.registrar.get(record.domain);
    const done: DomainRecord = { ...record, status: 'registered', expiresAt: details?.expiresAt };
    await deps.stores.saveDomain({ domain: record.domain, status: 'registered', expiresAt: details?.expiresAt });
    return done;
  } catch (error) {
    console.error('domain setup failed, retried on the next GET', record.domain, error);
    return record;
  }
}

/** A registration whose Lambda was cut off: registered after all → finish it; never registered → free the claim. */
async function recover(record: DomainRecord, deps: DomainDeps): Promise<DomainRecord | undefined> {
  if (!(await deps.registrar.get(record.domain))) {
    await deps.stores.releaseDomain(record.domain, record.slug);
    return undefined;
  }
  await deps.stores.saveDomain({ domain: record.domain, status: 'setup_pending', registeredAt: record.createdAt });
  return finishSetup({ ...record, status: 'setup_pending' }, deps);
}

export interface DomainView {
  domain: string;
  status: 'registering' | 'registered' | 'pending';
  expiresAt?: number;
}

/** What the owner sees: a setup the registrar hasn't finished reads as pending. */
export const domainView = (record: DomainRecord): DomainView => ({
  domain: record.domain,
  status: record.status === 'setup_pending' ? 'pending' : record.status,
  expiresAt: record.expiresAt,
});

/** GET /me/domain: the site's domain (finishing a setup left halfway) and whether registering is open. */
export async function domainPage(site: SiteRecord, deps: DomainDeps) {
  let record = site.domain ? await deps.stores.getDomain(site.domain) : undefined;
  if (record?.status === 'setup_pending') record = await finishSetup(record, deps);
  else if (record?.status === 'registering' && deps.now() - record.createdAt > STUCK_MS) record = await recover(record, deps);
  return { domain: record ? domainView(record) : undefined, registerOpen: await deps.registerOpen() };
}

/** A refusal from the registrar, with its machine-readable code (e.g. COST_MISMATCH). */
export class RegistrarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
