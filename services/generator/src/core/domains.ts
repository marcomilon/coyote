// The owner's own domain (Mi sitio → Dominio): search names, register one per site with the owner as registrant.
// The registrar is behind `Registrar` (aws/porkbun.ts). Coyote pays for now, so registering only works while the
// `./coyote.sh domain-register` switch is on, and a daily cap limits it. Pointing the domain at the site waits for publishing.
import { z } from 'zod';
import type { DomainRecord, SiteRecord, Stores } from './jobs';
import { day, inTwoDays } from './owner';
import { COUNTRIES, validForCountry } from './phones';
import { REGIONS } from './regions';

/** The TLDs offered: what the registrar sells that suits LatAm businesses. `.com.br`, `.com.ar`, `.cl`, `.pe` aren't sold. */
export const TLDS = ['com', 'com.mx', 'mx', 'co'] as const;
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
  /** First-year price in US cents; renewal may cost more (`.co`, `.com.mx`). */
  priceCents?: number;
}

export interface RegistrantContact {
  firstName: string;
  lastName: string;
  email: string;
  /** "+<code><number>", digits only after the "+". */
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, one of the form's countries (phones.ts). */
  country: string;
}

export interface Registrar {
  /** Registration and renewal price per TLD, in US cents. */
  prices(tlds: readonly string[]): Promise<Record<string, { registration: number; renewal: number }>>;
  check(domains: string[]): Promise<Quote[]>;
  /** Registers for the TLD's minimum term. `cost` must equal the current quote. Safe to retry with the same key. */
  register(domain: string, costCents: number, idempotencyKey: string): Promise<void>;
  /** The contact fields the registrar would refuse, checked before anything is charged. */
  contactProblems(contact: RegistrantContact): Promise<string[]>;
  /** Sets the contact for every role. */
  setContacts(domain: string, contact: RegistrantContact): Promise<void>;
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

const text = (max: number) => z.string().trim().min(1).max(max);
const Contact = z
  .object({
    firstName: text(60),
    lastName: text(60),
    email: z.string().trim().toLowerCase().pipe(z.email().max(200)),
    phone: z.string().trim().regex(/^\+\d{8,15}$/).refine((phone) => validForCountry(phone.slice(1))),
    address: text(120),
    city: text(60),
    state: text(60),
    postalCode: text(12),
    country: z.enum(COUNTRIES.map((c) => c.iso) as [string, ...string[]]),
  })
  .strict()
  .refine((c) => REGIONS[c.country]?.some(([, value]) => value === c.state) ?? false, { path: ['state'] });
const RegisterBody = z.object({ domain: z.string().max(80), contact: Contact }).strict();

export type RegisterResult =
  | { status: 201; domain: DomainView }
  | { status: 400; fields?: string[] }
  | { status: 403 | 429 }
  | { status: 409; error: 'has_domain' | 'not_available' | 'price_changed' }
  | { status: 502 };

/**
 * Registers the domain for the site: claim (one domain per site, one site per domain) → fresh quote → register →
 * owner as contact → auto-renew off. A failure after the registrar charged leaves `contacts_pending`, which GET retries.
 */
export async function registerDomain(site: SiteRecord, input: unknown, deps: DomainDeps): Promise<RegisterResult> {
  if (!(await deps.registerOpen())) return { status: 403 };
  const parsed = RegisterBody.safeParse(input);
  if (!parsed.success) return { status: 400, fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path.at(-1) ?? issue.path[0])))] };
  const { contact } = parsed.data;
  const domain = parsed.data.domain.trim().toLowerCase();
  if (!tldOf(domain)) return { status: 400, fields: ['domain'] };
  if (site.domain) return { status: 409, error: 'has_domain' };

  const problems = await deps.registrar.contactProblems(contact);
  if (problems.length) return { status: 400, fields: problems };
  const [quote] = await deps.registrar.check([domain]);
  if (quote?.status !== 'available' || !quote.priceCents) return { status: 409, error: 'not_available' };
  const now = deps.now();
  const record: DomainRecord = { domain, slug: site.slug, status: 'registering', createdAt: now, priceCents: quote.priceCents, ownerEmail: contact.email, contact };
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
  await deps.stores.saveDomain({ domain, status: 'contacts_pending', registeredAt: now });
  return { status: 201, domain: domainView(await finishSetup((await deps.stores.getDomain(domain))!, deps)) };
}

/** Owner as every contact, auto-renew off, expiry noted. Leaves `contacts_pending` if the registrar fails; GET retries. */
async function finishSetup(record: DomainRecord, deps: Pick<DomainDeps, 'stores' | 'registrar'>): Promise<DomainRecord> {
  try {
    if (record.contact) await deps.registrar.setContacts(record.domain, record.contact);
    await deps.registrar.setAutoRenew(record.domain, false);
    const details = await deps.registrar.get(record.domain);
    // The contact is only kept until the registrar has it.
    const done: DomainRecord = { ...record, status: 'registered', expiresAt: details?.expiresAt, contact: undefined };
    await deps.stores.saveDomain({ domain: record.domain, status: 'registered', expiresAt: details?.expiresAt, contact: null });
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
  await deps.stores.saveDomain({ domain: record.domain, status: 'contacts_pending', registeredAt: record.createdAt });
  return finishSetup({ ...record, status: 'contacts_pending' }, deps);
}

export interface DomainView {
  domain: string;
  status: 'registering' | 'registered' | 'pending';
  expiresAt?: number;
}

/** What the owner sees: the contact stays private, and a setup the registrar hasn't finished reads as pending. */
export const domainView = (record: DomainRecord): DomainView => ({
  domain: record.domain,
  status: record.status === 'contacts_pending' ? 'pending' : record.status,
  expiresAt: record.expiresAt,
});

/** GET /me/domain: the site's domain (finishing a setup left halfway), whether registering is open, and the prices. */
export async function domainPage(site: SiteRecord, deps: DomainDeps) {
  let record = site.domain ? await deps.stores.getDomain(site.domain) : undefined;
  if (record?.status === 'contacts_pending') record = await finishSetup(record, deps);
  else if (record?.status === 'registering' && deps.now() - record.createdAt > STUCK_MS) record = await recover(record, deps);
  const prices = await deps.registrar.prices(TLDS);
  const account = site.ownerEmailId ? await deps.stores.getAccount(site.ownerEmailId) : undefined;
  return {
    domain: record ? domainView(record) : undefined,
    registerOpen: await deps.registerOpen(),
    tlds: TLDS.filter((tld) => prices[tld]).map((tld) => ({ tld, priceCents: prices[tld]!.registration, renewalCents: prices[tld]!.renewal })),
    email: account?.email,
  };
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
