// Design packs and the site's monthly plan, paid through Paddle (aws/paddle.ts). The core never sees the provider's SDK
// or keys. The plan (one subscription per site) pays for the domain chosen at its checkout: once Paddle says it is
// active, the webhook orders that domain, and a queue registers it (domains.ts `runDomainOrder`), with retries.
import { tldOf, type Registrar } from './domains';
import { publishLive, takeDownLive } from './drafts';
import type { Billing, SiteRecord, Stores } from './jobs';
import { isSubscribed } from './plan';
import type { ModelTier } from './models';
import { addBoughtDesigns, DESIGNS_PER_PACK } from './paid-writes';

/** Marks our transactions: the Paddle sandbox account is shared with other apps. */
export const APP = 'coyote';

export interface Payments {
  /** A Paddle transaction for one price, made on our server so the browser can't choose what it buys or for whom. */
  createTransaction(priceId: string, customData: Record<string, string>): Promise<string>;
  /** True when the `Paddle-Signature` header signs this exact raw body, recently. */
  verify(rawBody: string, signature: string | undefined): Promise<boolean>;
  /** A short-lived link to Paddle's customer portal for this subscription (cancel, change the card). */
  portalUrl(customerId: string, subscriptionId: string): Promise<string>;
}

export interface PaymentDeps {
  stores: Stores;
  payments: Payments;
  /** The Paddle price of a design pack (CDK context `paddle.designsPriceId`). */
  designsPriceId: string;
  /** The Paddle price of the monthly plan (CDK context `paddle.hostingPriceId`). */
  hostingPriceId: string;
  /** Checks the plan's domain is still free before its checkout. */
  registrar?: Pick<Registrar, 'check'>;
  /** Hands an ordered domain to the registration queue. */
  queueDomainOrder?(slug: string, domain: string): Promise<void>;
  /** The tier of the model the next page write would use. Free-tier writes need no designs. */
  pageTier?(): Promise<ModelTier>;
  now(): number;
}

export type CheckoutKind = 'designs' | 'hosting';

export type CheckoutResult =
  | { status: 200; transactionId: string; email?: string }
  | { status: 400 }
  | { status: 409; error: 'not_needed' | 'subscribed' | 'has_domain' | 'not_available' };

/**
 * POST /me/checkout: a transaction for one design pack (for the owner's email), or for the site's monthly plan with
 * the domain it pays for (still free, and the site has none).
 */
export async function checkout(site: SiteRecord, deps: PaymentDeps, kind: CheckoutKind = 'designs', domainInput?: string): Promise<CheckoutResult> {
  if (!site.ownerEmailId) return { status: 409, error: 'not_needed' };
  if (kind === 'designs' && (await deps.pageTier?.()) === 'free') return { status: 409, error: 'not_needed' };
  const customData: Record<string, string> = { app: APP, kind, emailId: site.ownerEmailId, slug: site.slug };
  if (kind === 'hosting') {
    if (isSubscribed(site)) return { status: 409, error: 'subscribed' };
    const domain = domainInput?.trim().toLowerCase() ?? '';
    if (!tldOf(domain) || !deps.registrar) return { status: 400 };
    if (site.domain) return { status: 409, error: 'has_domain' };
    const [quote] = await deps.registrar.check([domain]);
    if (quote?.status !== 'available' || !quote.priceCents) return { status: 409, error: 'not_available' };
    customData.domain = domain;
  }
  const priceId = kind === 'designs' ? deps.designsPriceId : deps.hostingPriceId;
  const transactionId = await deps.payments.createTransaction(priceId, customData);
  const email = (await deps.stores.getAccount(site.ownerEmailId))?.email;
  return { status: 200, transactionId, ...(email && { email }) };
}

/** POST /me/billing/portal: Paddle's page to cancel the plan or change the card. */
export async function portal(site: SiteRecord, deps: PaymentDeps): Promise<{ status: 200; url: string } | { status: 409 }> {
  if (!site.billing) return { status: 409 };
  return { status: 200, url: await deps.payments.portalUrl(site.billing.customerId, site.billing.subscriptionId) };
}

interface PaddleEvent {
  event_type?: string;
  /** ISO date */
  occurred_at?: string;
  data?: {
    id?: string;
    status?: string;
    customer_id?: string;
    next_billed_at?: string | null;
    custom_data?: Record<string, unknown> | null;
    items?: { price?: { id?: string }; price_id?: string }[];
  };
}

const hasPrice = (data: PaddleEvent['data'], priceId: string) => !!priceId && !!data?.items?.some((item) => (item.price?.id ?? item.price_id) === priceId);

/**
 * POST /paddle/webhook, after the signature check. A completed design-pack transaction adds its designs to the email,
 * once per transaction. A subscription event (the transaction's custom_data carries over to its subscription) sets the
 * site's plan, unless a newer event already did. Every other event (other apps, other types) is acknowledged and ignored.
 */
export async function handleEvent(event: PaddleEvent, deps: PaymentDeps): Promise<'added' | 'repeated' | 'billed' | 'stale' | 'ignored'> {
  const { event_type: type, data } = event;
  const custom = data?.custom_data ?? {};
  if (custom.app !== APP) return 'ignored';
  if (type === 'transaction.completed' && custom.kind === 'designs') {
    const ownerEmailId = custom.emailId;
    if (typeof ownerEmailId !== 'string' || !ownerEmailId || !data?.id || !hasPrice(data, deps.designsPriceId)) return 'ignored';
    return (await addBoughtDesigns(deps.stores, ownerEmailId, data.id, DESIGNS_PER_PACK, deps.now())) ? 'added' : 'repeated';
  }
  if (type?.startsWith('subscription.') && custom.kind === 'hosting') {
    const slug = custom.slug;
    const updatedAt = Date.parse(event.occurred_at ?? '');
    if (typeof slug !== 'string' || !slug || !data?.id || !data.customer_id || !data.status || !Number.isFinite(updatedAt) || !hasPrice(data, deps.hostingPriceId)) return 'ignored';
    const billing: Billing = { subscriptionId: data.id, customerId: data.customer_id, status: data.status, updatedAt, ...(data.next_billed_at && { nextBilledAt: data.next_billed_at }) };
    const saved = await deps.stores.saveBilling(slug, billing);
    // From the site's plan as stored, not this event: a retried event (stale by then) still does what it should.
    const site = await deps.stores.getSite(slug);
    if (!site) return saved ? 'billed' : 'stale';
    const domain = custom.domain;
    if (isSubscribed(site) && !site.domain && !site.domainOrder && typeof domain === 'string' && tldOf(domain)) await orderDomain(slug, domain, deps);
    await followPlan(site, deps);
    return saved ? 'billed' : 'stale';
  }
  return 'ignored';
}

/** The plan is paid: order its domain once (duplicate events find the order set) and queue the registration. */
async function orderDomain(slug: string, domain: string, deps: PaymentDeps) {
  if (!(await deps.stores.orderDomain(slug, { domain, at: deps.now() }))) return;
  try {
    await deps.queueDomainOrder!(slug, domain);
  } catch (error) {
    await deps.stores.clearDomainOrder(slug); // Paddle retries the webhook, which orders it again
    throw error;
  }
}

/** Paying publishes: a plan that ends takes the site off its domain; paying again puts it back (once hosting is set up). */
async function followPlan(site: SiteRecord, deps: PaymentDeps) {
  if (!isSubscribed(site)) {
    if (site.status === 'published') await takeDownLive(site.slug, deps.stores);
    return;
  }
  if (site.status === 'published' || !site.domain) return;
  const record = await deps.stores.getDomain(site.domain);
  if (record?.hosting?.step === 'live') await publishLive(site, deps.stores);
}
