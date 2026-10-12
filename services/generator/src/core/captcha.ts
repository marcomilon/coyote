/**
 * The CAPTCHA on the anonymous forms (create, sign-in link, report): Cloudflare Turnstile (aws/turnstile.ts).
 * The browser sends the widget's token as `turnstileToken` in the JSON body; the check runs before any count,
 * model call, or email, so a bot spends nothing and uses up no real visitor's quota.
 */

/** `ok`: a person (or the switch is off). `bad`: no token or a refused one. `unreachable`: Cloudflare did not answer. */
export type HumanCheck = 'ok' | 'bad' | 'unreachable';
export type VerifyHuman = (token: string | undefined, ip: string) => Promise<HumanCheck>;

/**
 * True unless the token was refused. Cloudflare being down lets the request through: the rate limits still
 * apply, and a broken CAPTCHA must not stop real owners. No verifier (tests, local scripts): no check.
 */
export async function passesCaptcha(verify: VerifyHuman | undefined, token: unknown, ip: string): Promise<boolean> {
  if (!verify) return true;
  const result = await verify(typeof token === 'string' && token ? token : undefined, ip);
  if (result === 'unreachable') console.warn('Turnstile unreachable: request let through');
  return result !== 'bad';
}

/** The token field as the forms send it. Turnstile tokens are at most 2048 characters. */
export const TOKEN_MAX = 2048;
