/**
 * Where a generated page may load code, styles, and fonts from. The sanitizer, the final HTML check, and the
 * sites CSP (infra/lib/csp.ts) all read these lists, so they can never disagree. Images may come from any
 * https: host.
 */
export const SCRIPT_ORIGINS = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com', 'https://cdn.tailwindcss.com'];
export const STYLE_ORIGINS = ['https://fonts.googleapis.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
export const FONT_ORIGINS = ['https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];

const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

export const fromOrigins = (url: string, origins: string[]) => origins.includes(originOf(url.trim()) ?? '');
export const isHttpsUrl = (url: string) => originOf(url.trim()) !== undefined;
