import { FONT_ORIGINS, SCRIPT_ORIGINS, STYLE_ORIGINS } from '../../services/generator/src/core/cdn';

/** Content-Security-Policy strings. Inputs may be CloudFormation tokens, so this only joins strings. */

/**
 * Generated sites. Scripts are allowed (inline, and from the CDNs in cdn.ts), and images from any https: host.
 * `default-src 'none'` keeps `fetch`/XHR blocked, so a script cannot send data anywhere. The page may only be
 * framed by our app (Mi sitio shows the draft); the one frame it may hold is fill.ts's keyless Google map.
 */
export function sitesCsp(options: { formAction: string; frameAncestors: string[] }): string {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${SCRIPT_ORIGINS.join(' ')}`,
    `style-src 'unsafe-inline' ${STYLE_ORIGINS.join(' ')}`,
    `font-src ${FONT_ORIGINS.join(' ')}`,
    "img-src 'self' data: https:",
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
