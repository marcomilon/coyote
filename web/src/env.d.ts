interface Window {
  /** Set by /tags.js when the app has marketing tags (web/src/scripts/tags.ts). */
  COYOTE_TAGS?: boolean;
  dataLayer?: unknown[];
  COYOTE_CONFIG?: { apiUrl: string | null; examples?: Record<string, string>; turnstileSiteKey?: string; supportEmail?: string; paddle?: { env: 'sandbox' | 'production'; clientToken: string } };
}
