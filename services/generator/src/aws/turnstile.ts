// Cloudflare Turnstile (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
// The secret lives in Secrets Manager (👤 created by hand); `./coyote.sh captcha on|off` is the switch (SSM).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { HumanCheck, VerifyHuman } from '../core/captcha';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 3000;
/** The switch is read at most this often per container, so `captcha off` applies within a minute. */
const SWITCH_TTL_MS = 60_000;

let secret: Promise<string> | undefined;
let switchState: { on: boolean; at: number } | undefined;
const ssm = new SSMClient({});

/** The secret named by TURNSTILE_SECRET_NAME: the plain secret key, or JSON `{"secretKey": "…"}`. */
function turnstileSecret(env: Record<string, string | undefined>): Promise<string> {
  return (secret ??= (async () => {
    const { SecretString } = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: env.TURNSTILE_SECRET_NAME || 'coyote/turnstile' }));
    const value = (SecretString ?? '').trim();
    const key = value.startsWith('{') ? (JSON.parse(value) as { secretKey?: string }).secretKey : value;
    if (!key) throw new Error('the Turnstile secret is empty');
    return key;
  })().catch((error) => {
    secret = undefined;
    throw error;
  }));
}

/** The `captcha` switch: on only when the parameter says `on`. Unreadable: off (the rate limits still apply). */
async function captchaOn(env: Record<string, string | undefined>, now: number): Promise<boolean> {
  if (!env.CAPTCHA_PARAMETER) return false;
  if (switchState && now - switchState.at < SWITCH_TTL_MS) return switchState.on;
  let on = false;
  try {
    on = (await ssm.send(new GetParameterCommand({ Name: env.CAPTCHA_PARAMETER }))).Parameter?.Value === 'on';
  } catch (error) {
    console.error(`${env.CAPTCHA_PARAMETER} unreadable, CAPTCHA off`, error);
  }
  switchState = { on, at: now };
  return on;
}

/** The verifier the API handlers pass to the core flows. */
export function turnstile(env: Record<string, string | undefined> = process.env): VerifyHuman {
  return async (token, ip): Promise<HumanCheck> => {
    if (!(await captchaOn(env, Date.now()))) return 'ok';
    if (!token) return 'bad';
    try {
      const form = new URLSearchParams({ secret: await turnstileSecret(env), response: token, remoteip: ip });
      const response = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return 'unreachable';
      const result = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (result.success) return 'ok';
      // A wrong secret is our fault, not the visitor's: let them through and say so in the logs.
      if (result['error-codes']?.some((code) => code.includes('secret'))) {
        console.error('Turnstile secret refused', result['error-codes']);
        return 'unreachable';
      }
      return 'bad';
    } catch (error) {
      console.error('Turnstile check failed', error);
      return 'unreachable';
    }
  };
}
