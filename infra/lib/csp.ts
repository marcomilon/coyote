/** Content-Security-Policy strings. Inputs may be CloudFormation tokens, so this only joins strings. */
import { TAG_HOSTS } from './tags';


/**
 * Generated sites: pages the page writer wrote run their own inline scripts and libraries from a few CDNs
 * (page-check.ts lists them and removes any other). Scripts cannot fetch or send anything (no connect-src),
 * images load only from the site itself. The page may only be framed by our app (Mi sitio shows the draft).
 */
export function sitesCsp(options: { formAction: string; frameAncestors: string[]; scriptHosts: string[]; styleHosts: string[]; fontHosts: string[] }): string {
  const https = (hosts: string[]) => hosts.map((h) => `https://${h}`).join(' ');
  return [
    "default-src 'none'",
    // 'unsafe-eval': some libraries (Alpine) compile expressions; with no network access it adds nothing to inline scripts.
    `script-src 'unsafe-inline' 'unsafe-eval' ${https(options.scriptHosts)}`,
    `style-src 'unsafe-inline' ${https(options.styleHosts)}`,
    `font-src data: ${https(options.fontHosts)}`,
    "img-src 'self' data: blob:",
    // A Google map of the address (page-check allows the embed) (Google may redirect between the two hosts).
    'frame-src https://maps.google.com https://www.google.com',
    `form-action ${options.formAction}`,
    `frame-ancestors ${options.frameAncestors.join(' ')}`,
    "base-uri 'none'",
  ].join('; ');
}

/** Cloudflare Turnstile, the CAPTCHA on the anonymous forms: its script, and the iframe it draws the check in. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Paddle.js, the checkout of the design packs (web/src/scripts/paddle.ts): its script and styles, its API, and the checkout iframe. */
export const PADDLE = {
  script: 'https://cdn.paddle.com',
  connect: 'https://*.paddle.com',
  frame: ['https://buy.paddle.com', 'https://sandbox-buy.paddle.com'],
};

/** Our app: own scripts only (Astro emits external files), Turnstile's and Paddle's, with `tags` GTM's and the tags it loads (no inline scripts, so no Custom HTML tags), the API, the draft iframe and its photos (Mi sitio), direct S3 uploads. */
export function appCsp(options: { connectSrc: string[]; frameSrc: string[]; tags?: boolean }): string {
  const tags = (kind: keyof typeof TAG_HOSTS) => (options.tags ? TAG_HOSTS[kind] : []);
  return [
    "default-src 'self'",
    `script-src ${["'self'", TURNSTILE_ORIGIN, PADDLE.script, ...tags('script')].join(' ')}`,
    `style-src ${["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', PADDLE.script, ...tags('style')].join(' ')}`,
    'font-src https://fonts.gstatic.com',
    `img-src ${["'self'", 'data:', 'blob:', ...options.frameSrc, ...tags('img')].join(' ')}`,
    `connect-src ${[...options.connectSrc, PADDLE.connect, ...tags('connect')].join(' ')}`,
    `frame-src ${[...options.frameSrc, TURNSTILE_ORIGIN, ...PADDLE.frame, ...tags('frame')].join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
