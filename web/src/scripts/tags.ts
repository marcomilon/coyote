// Marketing tags (PLAN.md "Marketing tags"): our events for Google Tag Manager, which /tags.js loads and which turns
// them into Meta's and Google's, and the visitor's consent to them. Without tags (development, no container) the
// events go nowhere and the banner never shows.
import { CONSENT_KEY } from '../../../infra/lib/tags';

export type Consent = 'granted' | 'denied';

const queue = (): unknown[] => (window.dataLayer ??= []);
export const tagsOn = () => Boolean(window.COYOTE_TAGS);

/** Consent Mode's commands go to the dataLayer as an `arguments` object, the way Google's gtag() sends them. */
function gtag(..._args: unknown[]) {
  queue().push(arguments);
}

export function savedConsent(): Consent | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function setConsent(value: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Not saved: the choice still applies on this page.
  }
  gtag('consent', 'update', { ad_storage: value, ad_user_data: value, ad_personalization: value, analytics_storage: value });
  // GTM never retries a tag that consent held back: this page's PageView fires again on this event.
  if (value === 'granted') queue().push({ event: 'consent_granted' });
}

/**
 * An event for GTM. `done` runs once GTM has fired the event's tags, or after a second without them (no tags,
 * blocked, slow): for an event right before the page navigates away.
 */
export function track(event: string, params: Record<string, unknown> = {}, done?: () => void) {
  if (!tagsOn()) return void done?.();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done?.();
  };
  // GA4's ecommerce data stays in the dataLayer until replaced: clear it so one event's items never leak into the next.
  if ('ecommerce' in params) queue().push({ ecommerce: null });
  queue().push({ event, ...params, ...(done && { eventCallback: finish, eventTimeout: 1000 }) });
  if (done) setTimeout(finish, 1000);
}
