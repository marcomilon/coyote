// The registrar behind domains.ts: Porkbun's API v3 (https://porkbun.com/api/json/v3/documentation).
// Its DNS is free, so a domain costs only its registration. The key lives in Secrets Manager (👤 created by hand).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RegistrarError, type Quote, type RegistrantContact, type Registrar } from '../core/domains';
import { COUNTRIES } from '../core/phones';

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

const contactFields = (contact: RegistrantContact) => {
  const country = COUNTRIES.find((c) => contact.phone.startsWith(`+${c.dial}`) && (c.dial !== '1' || c.iso === contact.country)) ?? COUNTRIES.find((c) => contact.phone.startsWith(`+${c.dial}`))!;
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    address1: contact.address,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode,
    country: contact.country,
    phoneCountryCode: country.dial,
    phone: contact.phone.slice(1 + country.dial.length),
    email: contact.email,
  };
};

/** Porkbun's field names → ours, to point the owner at the field it refused. */
const FIELDS: Record<string, keyof RegistrantContact> = { firstName: 'firstName', lastName: 'lastName', address1: 'address', city: 'city', state: 'state', postalCode: 'postalCode', country: 'country', phone: 'phone', email: 'email' };
/** The fields a refusal message names ("registrant: \"X\" is not a valid state/province for MX."). */
const refusedFields = (message: string): string[] => {
  if (/state\/province/.test(message)) return ['state'];
  const found = Object.entries(FIELDS).filter(([theirs]) => new RegExp(`\\b${theirs}\\b`).test(message)).map(([, ours]) => ours);
  return found.length ? found : ['contact']; // a refusal we can't place: the form says to check the details
};

let anyDomain: Promise<string | undefined> | undefined;

let prices: Promise<Record<string, { registration: number; renewal: number }>> | undefined;

export const porkbun: Registrar = {
  prices(tlds) {
    // Prices change rarely: once per Lambda container is enough. A failure is not kept.
    prices ??= call<{ pricing: Record<string, { registration: string; renewal: string }> }>('pricing/get', { tlds })
      .then(({ pricing }) => Object.fromEntries(Object.entries(pricing).map(([tld, p]) => [tld, { registration: cents(p.registration)!, renewal: cents(p.renewal)! }])))
      .catch((error) => {
        prices = undefined;
        throw error;
      });
    return prices;
  },

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

  async setContacts(domain, contact) {
    await call(`domain/updateContacts/${domain}`, { contact: contactFields(contact) });
  },

  async contactProblems(contact) {
    // Porkbun has no contact check of its own: a dry run on a domain we already hold. None yet: nothing to check against.
    anyDomain ??= call<{ domains?: { domain: string }[] }>('domain/listAll').then(({ domains }) => domains?.[0]?.domain);
    const domain = await anyDomain;
    if (!domain) return [];
    try {
      await call(`domain/updateContacts/${domain}`, { contact: contactFields(contact), dryRun: true });
      return [];
    } catch (error) {
      if (error instanceof RegistrarError && error.code === 'INVALID_INPUT') return refusedFields(error.message);
      throw error;
    }
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
