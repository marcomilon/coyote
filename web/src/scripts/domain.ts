// Mi sitio → Dominio: search a .com name, then register it; Coyote is the
// registrant, so the owner only confirms (GET /me/domain, GET /me/domain/check, POST /me/domain; core/domains.ts).
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
  registerOpen: boolean;
}
export interface DomainStrings {
  status: Record<Quote['status'], string>;
  choose: string;
  invalid: string;
  limited: string;
  confirm: { title: string; working: string; submit: string };
  owned: Record<DomainView['status'], string>;
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

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;

export function startDomainTab(panel: HTMLElement, { api, strings, lang, slug }: { api: Api; strings: DomainStrings; lang: string; slug: string }) {
  const $ = <T extends Element>(selector: string) => panel.querySelector(selector) as T;
  const view = (name: 'loading' | 'owned' | 'search' | 'confirm') => (panel.dataset.domain = name);
  const searchForm = $<HTMLFormElement>('[data-domain-search]');
  const confirmForm = $<HTMLFormElement>('[data-domain-confirm]');
  const results = $<HTMLUListElement>('[data-domain-results]');
  const searchError = $<HTMLElement>('[data-domain-search-error]');
  const confirmError = $<HTMLElement>('[data-domain-error]');
  let page: Page;
  let chosen: Quote | undefined;

  function showOwned(domain: DomainView) {
    $('[data-domain-name]').textContent = domain.domain;
    const date = domain.expiresAt ? new Date(domain.expiresAt).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('[data-domain-status]').textContent = strings.owned[domain.status].replace('{date}', date);
    view('owned');
  }

  function renderQuotes(quotes: Quote[]) {
    results.replaceChildren(
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
    button.disabled = true;
    try {
      const { status, body } = await api<{ quotes: Quote[] }>(`/me/domain/check?q=${encodeURIComponent(q)}`);
      if (status === 200) return renderQuotes(body.quotes);
      results.replaceChildren();
      searchError.textContent = status === 400 ? strings.invalid : status === 429 ? strings.limited : strings.errors.registrar!;
    } catch {
      searchError.textContent = strings.errors.registrar!;
    } finally {
      button.disabled = false;
    }
  };

  function openConfirm(quote: Quote) {
    chosen = quote;
    $('[data-domain-chosen]').textContent = strings.confirm.title.replace('{domain}', quote.domain);
    confirmError.textContent = '';
    view('confirm');
    $<HTMLButtonElement>('[data-domain-submit]').focus();
  }

  $<HTMLButtonElement>('[data-domain-back]').onclick = () => view('search');

  confirmForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!chosen) return;
    const submit = $<HTMLButtonElement>('[data-domain-submit]');
    submit.disabled = true;
    submit.textContent = strings.confirm.working;
    try {
      const { status, body } = await api<{ domain?: DomainView; error?: string }>('/me/domain', 'POST', { domain: chosen.domain });
      if (status === 201 && body.domain) return showOwned(body.domain);
      confirmError.textContent = strings.errors[body.error ?? 'registrar'] ?? strings.errors.registrar!;
    } catch {
      confirmError.textContent = strings.errors.registrar!;
    } finally {
      submit.disabled = false;
      submit.textContent = strings.confirm.submit;
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
      page = { registerOpen: false };
    }
    if (page.domain) return showOwned(page.domain);
    $<HTMLElement>('[data-domain-closed]').hidden = page.registerOpen;
    view('search');
    if (!searchInput.value) {
      searchInput.value = domainLabel(slug);
      searchForm.requestSubmit();
    }
  }
  void load();
}
