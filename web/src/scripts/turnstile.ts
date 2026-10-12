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

/**
 * Renders the widget in `container` (inside the form) and starts the check at once. When a submit waits on a check
 * Cloudflare wants a click for, the container's `.human-hint` shows and the page scrolls to it.
 */
export function humanCheck(container: HTMLElement | null, lang: string): HumanCheck {
  const siteKey = window.COYOTE_CONFIG?.turnstileSiteKey;
  if (!siteKey || !container) return { token: async () => undefined, reset: () => {} };
  const hint = container.querySelector<HTMLElement>('.human-hint');
  const box = container.appendChild(document.createElement('div'));
  let interactive = false;
  const widget = loadTurnstile().then((turnstile) => {
    const id = turnstile?.render(box, {
      sitekey: siteKey,
      language: lang === 'pt' ? 'pt-br' : 'es',
      appearance: 'interaction-only',
      // Our app is always light; Turnstile's default follows the device and draws a dark box on a dark-mode phone.
      theme: 'light',
      'refresh-expired': 'auto',
      'before-interactive-callback': () => {
        interactive = true;
      },
      'after-interactive-callback': () => {
        interactive = false;
        if (hint) hint.hidden = true;
        container.classList.remove('attention');
      },
    });
    return turnstile && id !== undefined ? { turnstile, id } : undefined;
  });
  return {
    async token() {
      const w = await widget;
      if (!w) return undefined;
      const until = Date.now() + WAIT_MS;
      let shown = false;
      for (;;) {
        const token = w.turnstile.getResponse(w.id);
        if (token || Date.now() > until) return token || undefined;
        // Waiting on a click the visitor has not made: say so, bring the box into view, and draw the eye to it, once.
        if (interactive && !shown) {
          shown = true;
          if (hint) hint.hidden = false;
          container.scrollIntoView({ block: 'center', behavior: 'smooth' });
          container.classList.remove('attention');
          void container.offsetWidth; // restart the animation
          container.classList.add('attention');
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    reset() {
      void widget.then((w) => w?.turnstile.reset(w.id));
    },
  };
}
