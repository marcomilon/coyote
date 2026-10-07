/** Content-Security-Policy strings. Inputs may be CloudFormation tokens, so this only joins strings. */

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

/** Our app: own scripts only (Astro emits external files), the API, the draft iframe, direct S3 uploads. */
export function appCsp(options: { connectSrc: string[]; frameSrc: string[] }): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    `connect-src ${options.connectSrc.join(' ')}`,
    `frame-src ${options.frameSrc.join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
