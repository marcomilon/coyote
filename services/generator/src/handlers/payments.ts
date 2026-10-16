import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { pageTier } from '../aws/page-tier';
import { paddle } from '../aws/paddle';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { emitMetrics } from '../core/metrics';
import { authenticate } from '../core/owner';
import { checkout, handleEvent, type PaymentDeps } from '../core/payments';
import { json, perIpLimit } from './http';

const stores = createStores(storeConfigFromEnv());
const deps: PaymentDeps = { stores, payments: paddle, designsPriceId: process.env.PADDLE_DESIGNS_PRICE_ID ?? '', pageTier: () => pageTier(), now: Date.now };

// POST /me/checkout: same credential as Mi sitio.
const ownerRoutes = perIpLimit(stores, async (event) => {
  const site = await authenticate(event.headers.authorization, deps);
  if (site === 'rate_limited') return json(429, { error: 'rate_limited' });
  if (!site) return json(401, { error: 'unauthorized' });
  const result = await checkout(site, deps);
  if (result.status === 409) return json(409, { error: 'not_needed' });
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
  if (outcome === 'added') emitMetrics({ DesignPacksSold: 1 });
  console.log(JSON.stringify({ paddleEvent: (parsed as { event_type?: string }).event_type, outcome }));
  return json(200, { ok: true });
};
