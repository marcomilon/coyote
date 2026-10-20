// "Comprar 3 diseños", from Mi sitio's banner or a chat reply: a transaction from our API → Paddle's overlay →
// GET /me until the webhook has added the designs (services/generator core/payments.ts).
import { openCheckout } from './paddle';

export interface BuyStrings {
  buy: string;
  opening: string;
  waiting: string;
  done: string;
  late: string;
  failed: string;
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;

export interface BuyHandlers<V> {
  /** A line next to the button; empty clears it. */
  say(text: string, error?: boolean): void;
  /** While true the button is disabled. */
  busy(on: boolean): void;
  /** The designs arrived: the owner's view (GET /me) with them. */
  arrived(view: V): void;
  /** Paid, but the designs didn't arrive in time: the button stays disabled until the page is opened again. */
  late(): void;
}

/** How long to wait for Paddle's webhook to add the designs after a payment. */
const PAID_WAIT_MS = 60_000;

export async function buyDesignPack<V extends { designsLeft?: number }>(api: Api, lang: string, strings: BuyStrings, on: BuyHandlers<V>): Promise<void> {
  on.busy(true);
  on.say(strings.opening);
  try {
    const { status, body } = await api<{ transactionId?: string; email?: string }>('/me/checkout', 'POST', { kind: 'designs' });
    const opened = status === 200 && body?.transactionId && (await openCheckout({ transactionId: body.transactionId, email: body.email }, lang, () => void waitForDesigns()));
    on.say(opened ? '' : strings.failed, !opened);
  } catch {
    on.say(strings.failed, true);
  } finally {
    on.busy(false);
  }

  async function waitForDesigns() {
    on.say(strings.waiting);
    on.busy(true);
    for (const started = Date.now(); Date.now() - started < PAID_WAIT_MS; ) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { status, body } = await api<V>('/me').catch(() => ({ status: 0, body: undefined }));
      if (status === 200 && body && (body.designsLeft ?? 1) > 0) {
        on.busy(false);
        on.say(strings.done);
        on.arrived(body);
        return;
      }
    }
    on.busy(false);
    on.late();
    on.say(strings.late);
  }
}
