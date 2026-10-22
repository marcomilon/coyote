/**
 * /tags.js, our app's marketing tags (PLAN.md "Marketing tags"): Google Tag Manager, which sends our events to Meta
 * and Google, with Google's Consent Mode: nothing is stored or sent for ads or analytics until the visitor accepts
 * (web/src/scripts/tags.ts keeps the choice). Every page loads it before its own scripts. No container = an empty
 * file: no tags, and the consent banner never shows.
 */

/** The visitor's choice in localStorage ('granted' or 'denied'), shared with web/src/scripts/tags.ts. */
export const CONSENT_KEY = 'ventas314.consent';

/** Google Tag Manager, Google Analytics and the Meta Pixel (through GTM), for the app's CSP. */
export const TAG_HOSTS = {
  script: ['https://www.googletagmanager.com', 'https://tagmanager.google.com', 'https://connect.facebook.net'],
  // GTM's preview mode (Tag Assistant) styles its badge.
  style: ['https://www.googletagmanager.com', 'https://tagmanager.google.com'],
  img: ['https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://ssl.gstatic.com', 'https://www.gstatic.com', 'https://www.facebook.com'],
  connect: ['https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.facebook.com'],
  // Google Analytics sends through a service-worker iframe on googletagmanager.com.
  frame: ['https://www.googletagmanager.com'],
};

export function tagsJs(gtmId: string | undefined): string {
  if (!gtmId) return '// No marketing tags.\n';
  if (!/^GTM-[A-Z0-9]+$/.test(gtmId)) throw new Error(`gtmId must look like GTM-XXXXXXX, got ${gtmId}`);
  const consent = (value: string) =>
    JSON.stringify({ ad_storage: value, ad_user_data: value, ad_personalization: value, analytics_storage: value });
  return `// Marketing tags: Google Tag Manager with Consent Mode (infra/lib/tags.ts).
window.dataLayer = window.dataLayer || [];
window.COYOTE_TAGS = true;
(function () {
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', ${consent('denied')});
  try {
    if (localStorage.getItem(${JSON.stringify(CONSENT_KEY)}) === 'granted') gtag('consent', 'update', ${consent('granted')});
  } catch (e) {}
  addEventListener('load', function () {
    // Secrets in the address (an owner's token, a sign-in link, a job) never reach the tags: by now our scripts have
    // taken them out of it; if one is still there, this page goes without tags.
    if (/(^#|&)(token|login|job)=/.test(location.hash)) return;
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=${gtmId}';
    document.head.appendChild(script);
  });
})();
`;
}
