// The payment provider behind payments.ts: Paddle Billing's API (https://developer.paddle.com/api-reference).
// Plain fetch, no SDK. Keys live in Secrets Manager (👤 created by hand): `coyote/paddle` = {apiKey, webhookSecret}.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Payments } from '../core/payments';

/** A signature older than this is refused, so a captured webhook can't be replayed later. */
const MAX_AGE_SECONDS = 5 * 60;

interface Keys {
  apiKey: string;
  webhookSecret?: string;
}

let keys: Promise<Keys> | undefined;

function paddleKeys(env: Record<string, string | undefined> = process.env): Promise<Keys> {
  return (keys ??= (async () => {
    const { SecretString } = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: env.PADDLE_SECRET_NAME || 'coyote/paddle' }));
    const value = JSON.parse(SecretString ?? '{}') as Partial<Keys>;
    if (!value.apiKey) throw new Error('the Paddle secret needs apiKey');
    return { apiKey: value.apiKey, webhookSecret: value.webhookSecret };
  })()).catch((error) => {
    keys = undefined;
    throw error;
  });
}

const apiBase = (env: Record<string, string | undefined> = process.env) => (env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');

/** `ts=…;h1=…[;h1=…]` (several h1 while a secret rotates) checked against HMAC-SHA256(secret, `${ts}:${body}`). */
export function signatureMatches(rawBody: string, header: string | undefined, secret: string, nowSeconds: number): boolean {
  if (!header) return false;
  const parts = header.split(';').map((part) => part.split('=') as [string, string]);
  const ts = parts.find(([k]) => k === 'ts')?.[1];
  const signatures = parts.filter(([k]) => k === 'h1').map(([, v]) => v);
  if (!ts || !/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > MAX_AGE_SECONDS || signatures.length === 0) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest();
  return signatures.some((h1) => {
    const given = Buffer.from(h1 ?? '', 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export const paddle: Payments = {
  async createTransaction(priceId, customData) {
    const { apiKey } = await paddleKeys();
    const response = await fetch(`${apiBase()}/transactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ price_id: priceId, quantity: 1 }], custom_data: customData }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json().catch(() => ({}))) as { data?: { id?: string }; error?: { code?: string; detail?: string } };
    if (!response.ok || !result.data?.id) throw new Error(`Paddle transaction: HTTP ${response.status} ${result.error?.code ?? ''} ${result.error?.detail ?? ''}`);
    return result.data.id;
  },

  async verify(rawBody, signature) {
    const { webhookSecret } = await paddleKeys();
    if (!webhookSecret) throw new Error('the Paddle secret has no webhookSecret');
    return signatureMatches(rawBody, signature, webhookSecret, Math.floor(Date.now() / 1000));
  },
};
