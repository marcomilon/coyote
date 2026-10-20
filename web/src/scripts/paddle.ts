// The design-pack checkout (Mi sitio): Paddle.js's overlay, opened on a transaction our API made for the owner's
// email (services/generator core/payments.ts), so the browser never chooses what it buys or for whom. The designs
// arrive through Paddle's webhook, not from here: after `checkout.completed` the caller polls GET /me.
// No `paddle` in config.js (local builds, tests): no checkout.

interface PaddleEvent {
  name?: string;
}
interface PaddleJs {
  Environment: { set(env: string): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: { open(options: Record<string, unknown>): void; close(): void };
}
declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

const SCRIPT_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';
/** Long enough to see Paddle's tick, then the overlay closes by itself. */
const CLOSE_AFTER_MS = 4000;

let loading: Promise<PaddleJs | undefined> | undefined;
let onCompleted: (() => void) | undefined;

function loadPaddle(): Promise<PaddleJs | undefined> {
  const config = window.COYOTE_CONFIG?.paddle;
  if (!config) return Promise.resolve(undefined);
  return (loading ??= new Promise<PaddleJs | undefined>((resolve) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = () => {
      const paddle = window.Paddle;
      if (!paddle) return resolve(undefined);
      if (config.env === 'sandbox') paddle.Environment.set('sandbox');
      paddle.Initialize({
        token: config.clientToken,
        eventCallback: (event) => {
          if (event.name !== 'checkout.completed') return;
          onCompleted?.();
          // Paddle's success screen stays until closed; our page already says the payment arrived.
          setTimeout(() => paddle.Checkout.close(), CLOSE_AFTER_MS);
        },
      });
      resolve(paddle);
    };
    script.onerror = () => {
      loading = undefined;
      resolve(undefined);
    };
    document.head.append(script);
  }));
}

export const checkoutAvailable = () => Boolean(window.COYOTE_CONFIG?.paddle);

/**
 * Paddle's default payment link is our home page: its emails (a subscription's new card, a failed renewal) send the
 * owner there with `?_ptxn=<transaction>`, and Paddle.js opens that checkout by itself once initialized.
 */
export function openLinkedCheckout() {
  if (new URLSearchParams(location.search).has('_ptxn')) void loadPaddle();
}

/** Opens the checkout for a transaction from POST /me/checkout. Resolves to false when it couldn't open; `completed` runs once paid. */
export async function openCheckout(transaction: { transactionId: string; email?: string }, lang: string, completed: () => void): Promise<boolean> {
  const paddle = await loadPaddle();
  if (!paddle) return false;
  onCompleted = completed;
  paddle.Checkout.open({
    transactionId: transaction.transactionId,
    ...(transaction.email && { customer: { email: transaction.email } }),
    settings: { displayMode: 'overlay', theme: 'light', locale: lang === 'pt' ? 'pt' : 'es' },
  });
  return true;
}
