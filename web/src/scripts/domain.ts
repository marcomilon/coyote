// Mi sitio → Dominio: search a .com name, then register it; Coyote is the
// registrant, so the owner only confirms (GET /me/domain, GET /me/domain/check, POST /me/domain; core/domains.ts).
// Registering needs the site's monthly plan: the confirm screen opens Paddle's checkout for it with the chosen name
// (POST /me/checkout {kind: 'hosting', domain}). Once paid, the server registers that name by itself (webhook → queue,
// with retries; core/payments.ts, core/domains.ts runDomainOrder); this page only follows GET /me/domain.
// Loaded the first time the tab opens.

interface Quote {
  domain: string;
  status: 'available' | 'taken' | 'unknown';
  priceCents?: number;
}
interface DomainView {
  domain: string;
  status: 'registering' | 'registered' | 'pending';
  expiresAt?: number;
}
interface Page {
  domain?: DomainView;
  /** Free .com names for the business, without "-" (only when the site has no domain yet). */
  suggestions?: Quote[];
  registerOpen: boolean;
  plan: 'none' | 'active' | 'past_due' | 'paused' | 'canceled';
  /** The site on its domain (core/hosting.ts), once the domain is registered. */
  hosting?: 'setting_up' | 'live' | 'failed';
  liveUrl?: string;
  /** Paid, being registered on the server; `failed`: it couldn't be, and we were alerted. */
  order?: { domain: string; failed?: true };
}
export interface DomainStrings {
  status: Record<Quote['status'], string>;
  choose: string;
  invalid: string;
  limited: string;
  searchOther: string;
  confirm: { title: string; submit: string };
  plan: { waiting: string; late: string; failed: string; paused: string };
  owned: Record<DomainView['status'], string>;
  order: { pending: string; failed: string };
  hosting: { setting_up: string; live: string; failed: string };
  errors: Record<string, string>;
}
/**
 * What may go before ".com": a-z, 0-9 and "-", at most 63. A pasted address keeps only its name ("https://www.Luna.com/x"
 * → "luna"), accents are dropped ("ñandú" → "nandu"), spaces become "-", and anything else (".", "_", "@"…) is left out.
 */
export function domainLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\s*https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.com$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 63);
}

import { setBusy } from './busy';
import { openCheckout } from './paddle';

/** How long to follow a payment until the domain is registered (the server keeps trying after that). */
const PLAN_WAIT_MS = 120_000;
const subscribed = (plan: Page['plan']) => plan === 'active' || plan === 'past_due';

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;

export function startDomainTab(panel: HTMLElement, { api, strings, lang, slug }: { api: Api; strings: DomainStrings; lang: string; slug: string }) {
  const $ = <T extends Element>(selector: string) => panel.querySelector(selector) as T;
  const view = (name: 'loading' | 'owned' | 'search' | 'confirm') => (panel.dataset.domain = name);
  const searchForm = $<HTMLFormElement>('[data-domain-search]');
  const confirmForm = $<HTMLFormElement>('[data-domain-confirm]');
  const results = $<HTMLUListElement>('[data-domain-results]');
  const searchError = $<HTMLElement>('[data-domain-search-error]');
  const suggested = $<HTMLElement>('[data-domain-suggested]');
  const suggestions = $<HTMLUListElement>('[data-domain-suggestions]');
  const confirmError = $<HTMLElement>('[data-domain-error]');
  const planNotice = $<HTMLElement>('[data-domain-plan-notice]');
  const subscribe = $<HTMLButtonElement>('[data-domain-subscribe]');
  const submit = $<HTMLButtonElement>('[data-domain-submit]');
  let page: Page;
  let chosen: Quote | undefined;

  function showOwned(domain: DomainView) {
    $('[data-domain-name]').textContent = domain.domain;
    const date = domain.expiresAt ? new Date(domain.expiresAt).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('[data-domain-status]').textContent = strings.owned[domain.status].replace('{date}', date);
    $<HTMLButtonElement>('[data-domain-manage]').hidden = page.plan === 'none';
    showHosting(domain.domain);
    view('owned');
  }

  // Publishing on the domain: a line, the link once live; while it is being set up, GET /me/domain every 15 s.
  let hostingTimer: number | undefined;
  function showHosting(domain: string) {
    const line = $<HTMLElement>('[data-domain-hosting]');
    const link = $<HTMLAnchorElement>('[data-domain-live]');
    line.hidden = !page.hosting;
    if (page.hosting) line.textContent = strings.hosting[page.hosting].replace('{domain}', domain);
    link.hidden = page.hosting !== 'live' || !page.liveUrl;
    if (page.liveUrl) {
      link.href = page.liveUrl;
      link.textContent = domain;
    }
    window.clearTimeout(hostingTimer);
    if (page.hosting === 'setting_up') {
      hostingTimer = window.setTimeout(async () => {
        const { status, body } = await api<Page>('/me/domain').catch(() => ({ status: 0, body: undefined }));
        if (status === 200 && body?.domain) {
          page = body;
          showOwned(body.domain);
        } else showHosting(domain);
      }, 15_000);
    }
  }

  function showOrder(order: NonNullable<Page['order']>) {
    $('[data-domain-name]').textContent = order.domain;
    $('[data-domain-status]').textContent = order.failed ? strings.order.failed : strings.order.pending;
    $<HTMLButtonElement>('[data-domain-manage]').hidden = page.plan === 'none';
    $<HTMLElement>('[data-domain-hosting]').hidden = $<HTMLElement>('[data-domain-live]').hidden = true;
    view('owned');
  }

  // Without the plan: its price and "Activar plan" (or, while paused, Paddle's portal) instead of "Registrar dominio".
  function showPlan() {
    const paid = subscribed(page.plan);
    $<HTMLElement>('[data-domain-plan]').hidden = paid;
    subscribe.hidden = paid || page.plan === 'paused';
    $<HTMLButtonElement>('[data-domain-plan-manage]').hidden = page.plan !== 'paused';
    submit.hidden = !paid;
    if (page.plan === 'paused') planNotice.textContent = strings.plan.paused;
  }

  subscribe.onclick = async () => {
    setBusy(subscribe, true);
    confirmError.textContent = planNotice.textContent = '';
    try {
      const { status, body } = await api<{ transactionId?: string; email?: string; error?: string }>('/me/checkout', 'POST', { kind: 'hosting', domain: chosen!.domain });
      if (body.error === 'subscribed') return void (await follow()); // already paid (another tab): pick it up
      if (body.error === 'not_available' || body.error === 'has_domain') return void (confirmError.textContent = strings.errors[body.error]!);
      const opened = status === 200 && body.transactionId && (await openCheckout({ transactionId: body.transactionId, email: body.email }, lang, () => void follow()));
      if (!opened) confirmError.textContent = strings.plan.failed;
    } catch {
      confirmError.textContent = strings.plan.failed;
    } finally {
      setBusy(subscribe, false);
    }
  };

  // After paying: GET /me/domain until the server has registered the name (the order shows meanwhile).
  async function follow() {
    planNotice.textContent = strings.plan.waiting;
    setBusy(subscribe, true);
    for (const started = Date.now(); Date.now() - started < PLAN_WAIT_MS; ) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { status, body } = await api<Page>('/me/domain').catch(() => ({ status: 0, body: undefined }));
      if (status !== 200 || !body) continue;
      page = body;
      if (body.domain) return showOwned(body.domain);
      if (body.order) {
        showOrder(body.order);
        if (body.order.failed) return;
      }
    }
    setBusy(subscribe, false);
    if (!page.order) planNotice.textContent = strings.plan.late;
  }

  // Paddle's customer portal: cancel the plan, change the card, resume it.
  async function manage(button: HTMLButtonElement) {
    setBusy(button, true);
    try {
      const { status, body } = await api<{ url?: string }>('/me/billing/portal', 'POST', {});
      if (status === 200 && body.url) window.open(body.url, '_blank', 'noopener');
      else confirmError.textContent = strings.errors.registrar!;
    } catch {
      confirmError.textContent = strings.errors.registrar!;
    } finally {
      setBusy(button, false);
    }
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-domain-manage], [data-domain-plan-manage]')) button.onclick = () => void manage(button);

  function renderQuotes(list: HTMLUListElement, quotes: Quote[]) {
    list.replaceChildren(
      ...quotes.map((quote) => {
        const item = document.createElement('li');
        item.dataset.status = quote.status;
        const name = document.createElement('strong');
        name.textContent = quote.domain;
        const state = document.createElement('span');
        state.className = 'state';
        state.textContent = strings.status[quote.status];
        item.append(name, state);
        if (quote.status === 'available' && quote.priceCents) {
          const choose = document.createElement('button');
          choose.type = 'button';
          choose.className = 'btn small blue';
          choose.textContent = strings.choose;
          choose.disabled = !page.registerOpen;
          choose.onclick = () => openConfirm(quote);
          item.append(choose);
        }
        return item;
      }),
    );
  }

  // The box ends in a fixed ".com", so it takes only what goes before it, cleaned as it is typed or pasted.
  const searchInput = searchForm.elements.namedItem('q') as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    const before = searchInput.value;
    const clean = domainLabel(before);
    if (clean === before) return;
    const caret = Math.max(0, (searchInput.selectionStart ?? before.length) - (before.length - clean.length));
    searchInput.value = clean;
    searchInput.setSelectionRange(caret, caret);
  });

  searchForm.onsubmit = async (event) => {
    event.preventDefault();
    const q = (searchInput.value = domainLabel(searchInput.value).replace(/^-+|-+$/g, ''));
    searchError.textContent = '';
    const button = searchForm.querySelector('button')!;
    setBusy(button, true);
    try {
      const { status, body } = await api<{ quotes: Quote[] }>(`/me/domain/check?q=${encodeURIComponent(q)}`);
      if (status === 200) return renderQuotes(results, body.quotes);
      results.replaceChildren();
      searchError.textContent = status === 400 ? strings.invalid : status === 429 ? strings.limited : strings.errors.registrar!;
    } catch {
      searchError.textContent = strings.errors.registrar!;
    } finally {
      setBusy(button, false);
    }
  };

  function openConfirm(quote: Quote) {
    chosen = quote;
    $('[data-domain-chosen]').textContent = strings.confirm.title;
    $('[data-domain-chosen-name]').textContent = quote.domain;
    confirmError.textContent = planNotice.textContent = '';
    showPlan();
    view('confirm');
    (submit.hidden ? subscribe : submit).focus();
  }

  $<HTMLButtonElement>('[data-domain-back]').onclick = () => view('search');

  confirmForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!chosen || submit.hidden) return;
    setBusy(submit, true);
    try {
      const { status, body } = await api<{ domain?: DomainView; error?: string }>('/me/domain', 'POST', { domain: chosen.domain });
      if (status === 201 && body.domain) return showOwned(body.domain);
      if (body.error === 'needs_plan') {
        page.plan = 'none';
        showPlan();
      }
      confirmError.textContent = strings.errors[body.error ?? 'registrar'] ?? strings.errors.registrar!;
    } catch {
      confirmError.textContent = strings.errors.registrar!;
    } finally {
      setBusy(submit, false);
    }
  };

  async function load() {
    view('loading');
    try {
      const { status, body } = await api<Page>('/me/domain');
      if (status !== 200) throw new Error(String(status));
      page = body;
    } catch {
      searchError.textContent = strings.errors.registrar!;
      page = { registerOpen: false, plan: 'none' };
    }
    if (page.domain) return showOwned(page.domain);
    if (page.order) {
      showOrder(page.order);
      return void (page.order.failed || (await follow()));
    }
    $<HTMLElement>('[data-domain-closed]').hidden = page.registerOpen;
    view('search');
    // The suggestions come first; the search is for a name the owner likes better.
    if (page.suggestions?.length) {
      suggested.hidden = false;
      $('[data-domain-search-label]').textContent = strings.searchOther;
      return renderQuotes(suggestions, page.suggestions);
    }
    // No suggestions (the registry didn't answer): search the site's name, joined.
    if (!searchInput.value) {
      searchInput.value = domainLabel(slug).replace(/-/g, '');
      searchForm.requestSubmit();
    }
  }
  void load();
}
