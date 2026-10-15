// The registrar behind domains.ts: Porkbun's API v3 (https://porkbun.com/api/json/v3/documentation).
// Its DNS is free, so a domain costs only its registration. The key lives in Secrets Manager (👤 created by hand).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RegistrarError, type Quote, type Registrar } from '../core/domains';

const BASE = 'https://api.porkbun.com/api/json/v3/';

interface Keys {
  apikey: string;
  secretapikey: string;
}

let keys: Promise<Keys> | undefined;

/** `{apikey, secretapikey}` from the secret named by PORKBUN_SECRET_NAME (default coyote/porkbun-api). */
function porkbunKeys(env: Record<string, string | undefined> = process.env): Promise<Keys> {
  return (keys ??= (async () => {
    const { SecretString } = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: env.PORKBUN_SECRET_NAME || 'coyote/porkbun-api' }));
    const value = JSON.parse(SecretString ?? '{}') as Partial<Keys>;
    if (!value.apikey || !value.secretapikey) throw new Error('the Porkbun secret needs apikey and secretapikey');
    return { apikey: value.apikey, secretapikey: value.secretapikey };
  })());
}

const cents = (usd: string | undefined) => (usd ? Math.round(Number(usd) * 100) : undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One API call. A 429 is retried once after Retry-After; an ERROR answer throws a RegistrarError with its code. */
async function call<T>(path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}, retried = false): Promise<T> {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...(await porkbunKeys()), ...body }),
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 429 && !retried) {
    await sleep(Math.min(Number(response.headers.get('retry-after')) || 2, 5) * 1000);
    return call(path, body, headers, true);
  }
  const result = (await response.json().catch(() => ({}))) as { status?: string; code?: string; message?: string };
  if (result.status !== 'SUCCESS') throw new RegistrarError(result.code ?? `HTTP_${response.status}`, `${path}: ${result.message ?? response.statusText}`);
  return result as T;
}

interface CheckAnswer {
  avail?: 'yes' | 'no';
  price?: string;
  premium?: 'yes' | 'no';
}

const quote = (domain: string, answer: CheckAnswer | undefined): Quote => {
  if (!answer?.avail) return { domain, status: 'unknown' };
  // Premium names cost far more than the list price: treated as taken.
  if (answer.avail === 'no' || answer.premium === 'yes') return { domain, status: 'taken' };
  return { domain, status: 'available', priceCents: cents(answer.price) };
};

export const porkbun: Registrar = {
  async check(domains) {
    if (domains.length === 1) {
      const domain = domains[0]!;
      const { response } = await call<{ response: CheckAnswer }>(`domain/checkDomain/${domain}`);
      return [quote(domain, response)];
    }
    const result = await call<{ domains?: Record<string, CheckAnswer> }>('domain/checkDomain', { domains });
    return domains.map((domain) => quote(domain, result.domains?.[domain]));
  },

  async register(domain, costCents, idempotencyKey) {
    await call(`domain/create/${domain}`, { cost: costCents, agreeToTerms: 'yes', whoisPrivacy: true }, { 'Idempotency-Key': idempotencyKey });
  },

  async setAutoRenew(domain, on) {
    await call(`domain/updateAutoRenew/${domain}`, { status: on ? 'on' : 'off' });
  },

  async get(domain) {
    try {
      const { domain: details } = await call<{ domain: { expireDate?: string } }>(`domain/get/${domain}`);
      const expiresAt = details.expireDate ? Date.parse(`${details.expireDate.replace(' ', 'T')}Z`) : undefined;
      return { expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined };
    } catch (error) {
      if (error instanceof RegistrarError && error.code === 'DOMAIN_NOT_FOUND') return undefined;
      throw error;
    }
  },
};
