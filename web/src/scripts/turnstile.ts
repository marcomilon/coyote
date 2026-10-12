// The CAPTCHA on the anonymous forms (create, sign-in link, report): Cloudflare Turnstile, rendered explicitly so
// it stays invisible unless Cloudflare wants a click. The API checks the token (services/generator aws/turnstile.ts).
// No site key in config.js (local builds, tests): no widget, and the forms send no token.

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  getResponse(widgetId: string): string | undefined;
  reset(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** How long a submit waits for the check (a visitor may need to click it). */
const WAIT_MS = 30_000;

let loading: Promise<Turnstile | undefined> | undefined;

function loadTurnstile(): Promise<Turnstile | undefined> {
  return (loading ??= new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => resolve(undefined); // blocked or offline: the form still sends, and the API decides
    document.head.append(script);
  }));
}

export interface HumanCheck {
  /** The current token, waiting for the check to finish. Undefined with no widget or when it never finished. */
  token(): Promise<string | undefined>;
  /** A token works once: call after every answer from the API, so the next submit gets a fresh one. */
  reset(): void;
}

/** Renders the widget in `container` (an empty element inside the form) and starts the check at once. */
export function humanCheck(container: HTMLElement | null, lang: string): HumanCheck {
  const siteKey = window.COYOTE_CONFIG?.turnstileSiteKey;
  if (!siteKey || !container) return { token: async () => undefined, reset: () => {} };
  const widget = loadTurnstile().then((turnstile) => {
    const id = turnstile?.render(container, {
      sitekey: siteKey,
      language: lang === 'pt' ? 'pt-br' : 'es',
      appearance: 'interaction-only',
      // Our app is always light; Turnstile's default follows the device and draws a dark box on a dark-mode phone.
      theme: 'light',
      'refresh-expired': 'auto',
    });
    return turnstile && id !== undefined ? { turnstile, id } : undefined;
  });
  return {
    async token() {
      const w = await widget;
      if (!w) return undefined;
      const until = Date.now() + WAIT_MS;
      for (;;) {
        const token = w.turnstile.getResponse(w.id);
        if (token || Date.now() > until) return token || undefined;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    reset() {
      void widget.then((w) => w?.turnstile.reset(w.id));
    },
  };
}
