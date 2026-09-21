/** Content-Security-Policy strings. Inputs may be CloudFormation tokens, so this only joins strings. */

/** Generated sites: no scripts at all. The page may only be framed by our app (preview). */
export function sitesCsp(options: { formAction: string; frameAncestors: string[] }): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    `form-action ${options.formAction}`,
    `frame-ancestors ${options.frameAncestors.join(' ')}`,
    "base-uri 'none'",
  ].join('; ');
}

/** Our app: own scripts only (Astro emits external files), the API, the preview iframe, direct S3 uploads. */
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
