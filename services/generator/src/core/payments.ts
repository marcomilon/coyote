// Design packs, paid through Paddle (aws/paddle.ts). The core never sees the provider's SDK or keys.
import type { SiteRecord, Stores } from './jobs';
import type { ModelTier } from './models';
import { addBoughtDesigns, DESIGNS_PER_PACK } from './paid-writes';

/** Marks our transactions: the Paddle sandbox account is shared with other apps. */
export const APP = 'coyote';

export interface Payments {
  /** A Paddle transaction for one price, made on our server so the browser can't choose what it buys or for whom. */
  createTransaction(priceId: string, customData: Record<string, string>): Promise<string>;
  /** True when the `Paddle-Signature` header signs this exact raw body, recently. */
  verify(rawBody: string, signature: string | undefined): Promise<boolean>;
}

export interface PaymentDeps {
  stores: Stores;
  payments: Payments;
  /** The Paddle price of a design pack (CDK context `paddle.designsPriceId`). */
  designsPriceId: string;
  /** The tier of the model the next page write would use. Free-tier writes need no designs. */
  pageTier?(): Promise<ModelTier>;
  now(): number;
}

/** POST /me/checkout: a transaction for one design pack, for the site owner's email. */
export async function checkout(site: SiteRecord, deps: PaymentDeps): Promise<{ status: 200; transactionId: string; email?: string } | { status: 409 }> {
  if (!site.ownerEmailId || (await deps.pageTier?.()) === 'free') return { status: 409 };
  const transactionId = await deps.payments.createTransaction(deps.designsPriceId, { app: APP, kind: 'designs', emailId: site.ownerEmailId, slug: site.slug });
  const email = (await deps.stores.getAccount(site.ownerEmailId))?.email;
  return { status: 200, transactionId, ...(email && { email }) };
}

interface PaddleEvent {
  event_type?: string;
  data?: {
    id?: string;
    custom_data?: Record<string, unknown> | null;
    items?: { price?: { id?: string }; price_id?: string }[];
  };
}

/**
 * POST /paddle/webhook, after the signature check. A completed design-pack transaction adds its designs to the email,
 * once per transaction. Every other event (other apps, other types) is acknowledged and ignored.
 */
export async function handleEvent(event: PaddleEvent, deps: PaymentDeps): Promise<'added' | 'repeated' | 'ignored'> {
  const { event_type: type, data } = event;
  const custom = data?.custom_data ?? {};
  if (type !== 'transaction.completed' || custom.app !== APP || custom.kind !== 'designs') return 'ignored';
  const ownerEmailId = custom.emailId;
  const paid = data?.items?.some((item) => (item.price?.id ?? item.price_id) === deps.designsPriceId);
  if (typeof ownerEmailId !== 'string' || !ownerEmailId || !data?.id || !paid) return 'ignored';
  return (await addBoughtDesigns(deps.stores, ownerEmailId, data.id, DESIGNS_PER_PACK, deps.now())) ? 'added' : 'repeated';
}
