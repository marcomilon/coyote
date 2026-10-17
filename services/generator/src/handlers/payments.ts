import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { pageTier } from '../aws/page-tier';
import { paddle } from '../aws/paddle';
import { porkbun } from '../aws/porkbun';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { emitMetrics } from '../core/metrics';
import { authenticate } from '../core/owner';
import { z } from 'zod';
import { checkout, handleEvent, portal, type PaymentDeps } from '../core/payments';
import { json, parseBody, perIpLimit } from './http';

const stores = createStores(storeConfigFromEnv());
const sqs = new SQSClient({});
const deps: PaymentDeps = {
  stores,
  payments: paddle,
  designsPriceId: process.env.PADDLE_DESIGNS_PRICE_ID ?? '',
  hostingPriceId: process.env.PADDLE_HOSTING_PRICE_ID ?? '',
  registrar: porkbun,
  // The domain-order Lambda registers it (handlers/domain-order.ts).
  async queueDomainOrder(slug, domain) {
    await sqs.send(new SendMessageCommand({ QueueUrl: process.env.DOMAIN_ORDERS_QUEUE_URL, MessageBody: JSON.stringify({ slug, domain }) }));
  },
  pageTier: () => pageTier(),
  now: Date.now,
};

const CheckoutBody = z.object({ kind: z.enum(['designs', 'hosting']).default('designs'), domain: z.string().max(80).optional() }).strict();

// POST /me/checkout {kind?, domain?} · POST /me/billing/portal: same credential as Mi sitio.
const ownerRoutes = perIpLimit(stores, async (event) => {
  const site = await authenticate(event.headers.authorization, deps);
  if (site === 'rate_limited') return json(429, { error: 'rate_limited' });
  if (!site) return json(401, { error: 'unauthorized' });
  if (event.routeKey === 'POST /me/billing/portal') {
    const result = await portal(site, deps);
    return result.status === 200 ? json(200, { url: result.url }) : json(409, { error: 'no_plan' });
  }
  const body = CheckoutBody.safeParse(parseBody(event.body, event.isBase64Encoded) ?? {});
  if (!body.success) return json(400, { error: 'invalid' });
  const result = await checkout(site, deps, body.data.kind, body.data.domain);
  if (result.status === 400) return json(400, { error: 'invalid' });
  if (result.status === 409) return json(409, { error: result.error });
  return json(200, { transactionId: result.transactionId, ...(result.email && { email: result.email }) });
});

// POST /paddle/webhook: Paddle's servers, no credential but the signature on the raw body. A 5xx makes Paddle retry.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (event.routeKey !== 'POST /paddle/webhook') return ownerRoutes(event);
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  if (!(await paddle.verify(raw, event.headers['paddle-signature']))) return json(400, { error: 'signature' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: 'invalid' });
  }
  const outcome = await handleEvent(parsed as Parameters<typeof handleEvent>[0], deps);
  const type = (parsed as { event_type?: string }).event_type;
  if (outcome === 'added') emitMetrics({ DesignPacksSold: 1 });
  if (outcome === 'billed' && type === 'subscription.activated') emitMetrics({ PlansStarted: 1 });
  console.log(JSON.stringify({ paddleEvent: type, outcome }));
  return json(200, { ok: true });
};
