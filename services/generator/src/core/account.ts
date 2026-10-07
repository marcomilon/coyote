import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Stores } from './jobs';
import { loginEmail, type SendEmail } from './mail';
import { hashIp } from './ratelimit';
import { emailId, newSecret, secretMatches, sha256 } from './token';
import type { Urls } from './urls';

/**
 * "Mis sitios": every site is linked to the email the owner gave in the form. The owner asks for a sign-in link
 * by email (single use, 1 hour), which opens a session (30 days, kept in that browser). A session reaches each
 * of its sites with the token `<slug>.@<sessionId>.<secret>`: the shape of a magic link, so Mi sitio, the chat,
 * and the QR work with it unchanged (`authenticate` in owner.ts checks the session).
 */

export const LOGIN_TTL_MS = 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGINS_PER_EMAIL_PER_DAY = 3;
const LOGINS_PER_IP_PER_DAY = 10;

export interface AccountDeps {
  stores: Stores;
  urls: Urls;
  /** Undefined when no sender is set up. */
  sendEmail?: SendEmail;
  now(): number;
  ipSalt: string;
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const inTwoDays = (now: number) => Math.floor(now / 1000) + 2 * 86400;

/** A new site joins its owner's account. Called once, when the site's first draft is ready. */
export async function linkSite(stores: Stores, email: string, lang: 'es' | 'pt', site: { slug: string; businessName: string; createdAt: number }): Promise<string> {
  const id = emailId(email);
  await stores.linkAccountSite(id, email.trim().toLowerCase(), lang, site);
  await stores.saveSite({ slug: site.slug, ownerEmailId: id });
  return id;
}

/** A sign-in link for an account. Resolves to the secret that goes in the link. */
export async function issueLogin(stores: Stores, id: string, now: number): Promise<string> {
  const secret = newSecret();
  await stores.putAccountToken({ kind: 'login', id: sha256(secret), emailId: id, expiresAt: now + LOGIN_TTL_MS });
  return secret;
}

const LoginBody = z.object({ email: z.email().max(120), lang: z.enum(['es', 'pt']).default('es') }).strict();

/**
 * POST /account/login. Always the same answer, so it never tells whether an email has sites. The email goes out
 * only to an account that exists, within the caps.
 */
export async function requestLogin(body: unknown, ip: string, deps: AccountDeps): Promise<{ status: 202 | 400 | 503 }> {
  const parsed = LoginBody.safeParse(body ?? {});
  if (!parsed.success) return { status: 400 };
  if (!deps.sendEmail) return { status: 503 };
  const { stores } = deps;
  const now = deps.now();
  const id = emailId(parsed.data.email);
  const allowed =
    (await stores.hitRateLimit(`login-ip#${hashIp(ip, deps.ipSalt)}#${day(now)}`, LOGINS_PER_IP_PER_DAY, inTwoDays(now))) &&
    (await stores.hitRateLimit(`login#${id}#${day(now)}`, LOGINS_PER_EMAIL_PER_DAY, inTwoDays(now)));
  const account = allowed ? await stores.getAccount(id) : undefined;
  if (!account || account.sites.length === 0) return { status: 202 };
  const secret = await issueLogin(stores, id, now);
  const names = account.sites.map((s) => s.businessName);
  await deps.sendEmail(loginEmail(account.email, parsed.data.lang, names, deps.urls.mySitesUrl(secret, parsed.data.lang)));
  return { status: 202 };
}

const SessionBody = z.object({ login: z.string().min(20).max(100) }).strict();

/** POST /account/session: a sign-in link (once) → a session token `@<id>.<secret>`. */
export async function startSession(body: unknown, deps: Pick<AccountDeps, 'stores' | 'now'>): Promise<{ status: 200; token: string; expiresAt: number } | { status: 400 | 401 }> {
  const parsed = SessionBody.safeParse(body ?? {});
  if (!parsed.success) return { status: 400 };
  const now = deps.now();
  const login = await deps.stores.takeAccountToken('login', sha256(parsed.data.login));
  if (!login || login.expiresAt < now) return { status: 401 };
  const id = randomBytes(9).toString('base64url');
  const secret = newSecret();
  const expiresAt = now + SESSION_TTL_MS;
  await deps.stores.putAccountToken({ kind: 'session', id, emailId: login.emailId, secretHash: sha256(secret), expiresAt });
  return { status: 200, token: `@${id}.${secret}`, expiresAt };
}

/** A session token (`@<id>.<secret>`, with or without the `@`) → its account's `emailId`, or undefined. */
export async function checkSession(token: string, { stores, now }: Pick<AccountDeps, 'stores' | 'now'>): Promise<string | undefined> {
  const [id, secret] = token.replace(/^@/, '').split('.');
  if (!id || !secret) return undefined;
  const session = await stores.getAccountToken('session', id);
  if (!session?.secretHash || session.expiresAt < now() || !secretMatches(secret, session.secretHash)) return undefined;
  return session.emailId;
}

/** GET /account: the account's sites, newest first, with their current drafts. */
export async function accountView(id: string, { stores, urls }: Pick<AccountDeps, 'stores' | 'urls'>) {
  const account = await stores.getAccount(id);
  const sites = [];
  for (const link of account?.sites ?? []) {
    const site = await stores.getSite(link.slug);
    if (!site?.currentDraftId || site.ownerEmailId !== id) continue;
    sites.push({ ...link, draftUrl: urls.draftUrl(site.currentDraftId), previewUrl: site.previewId ? urls.draftUrl(site.previewId) : undefined });
  }
  sites.sort((a, b) => b.createdAt - a.createdAt);
  return { email: account?.email, sites };
}
