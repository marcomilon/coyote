// Mi sitio → Dominio: search a name under every TLD we sell, then register one with the owner as registrant
// (GET /me/domain, GET /me/domain/check, POST /me/domain; core/domains.ts). Loaded the first time the tab opens.
import { REGIONS } from '../../../services/generator/src/core/regions';
import { fullNumber, setUpCountryPicker } from './phone';

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
  tlds: { tld: string; priceCents: number; renewalCents: number }[];
  email?: string;
}
export interface DomainStrings {
  status: Record<Quote['status'], string>;
  price: string;
  choose: string;
  invalid: string;
  limited: string;
  contact: { title: string; paid: string; working: string; submit: string; fieldError: string; statePick: string };
  owned: Record<DomainView['status'], string>;
  errors: Record<string, string>;
}
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }>;

const usd = (cents: number, lang: string) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }).format(cents / 100).replace(/^\$/, 'US$');

export function startDomainTab(panel: HTMLElement, { api, strings, lang, slug }: { api: Api; strings: DomainStrings; lang: string; slug: string }) {
  const $ = <T extends Element>(selector: string) => panel.querySelector(selector) as T;
  const view = (name: 'loading' | 'owned' | 'search' | 'contact') => (panel.dataset.domain = name);
  const searchForm = $<HTMLFormElement>('[data-domain-search]');
  const contactForm = $<HTMLFormElement>('[data-domain-contact]');
  const results = $<HTMLUListElement>('[data-domain-results]');
  const searchError = $<HTMLElement>('[data-domain-search-error]');
  const contactError = $<HTMLElement>('[data-domain-error]');
  const input = (name: string) => contactForm.elements.namedItem(name) as HTMLInputElement;
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
        const tld = page.tlds.find((t) => quote.domain.endsWith(`.${t.tld}`));
        const item = document.createElement('li');
        item.dataset.status = quote.status;
        const name = document.createElement('strong');
        name.textContent = quote.domain;
        const state = document.createElement('span');
        state.className = 'state';
        state.textContent = strings.status[quote.status];
        item.append(name, state);
        if (quote.status === 'available' && quote.priceCents) {
          const price = document.createElement('span');
          price.className = 'price';
          price.textContent = strings.price.replace('{price}', usd(quote.priceCents, lang)).replace('{renewal}', usd(tld?.renewalCents ?? quote.priceCents, lang));
          const choose = document.createElement('button');
          choose.type = 'button';
          choose.className = 'btn small blue';
          choose.textContent = strings.choose;
          choose.disabled = !page.registerOpen;
          choose.onclick = () => openContact(quote);
          item.append(price, choose);
        }
        return item;
      }),
    );
  }

  searchForm.onsubmit = async (event) => {
    event.preventDefault();
    const q = (searchForm.elements.namedItem('q') as HTMLInputElement).value;
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

  // The registrar only takes its own spelling of each state: a list per country (core/regions.ts), local names shown.
  const country = input('country') as unknown as HTMLSelectElement;
  const state = input('state') as unknown as HTMLSelectElement;
  const syncStates = () => {
    const regions = [...(REGIONS[country.value] ?? [])].sort((a, b) => a[0].localeCompare(b[0], lang));
    const pick = new Option(regions.length ? '' : strings.contact.statePick, '');
    state.replaceChildren(pick, ...regions.map(([label, value]) => new Option(label, value)));
  };
  setUpCountryPicker(country, input('phone'));
  country.addEventListener('change', syncStates);
  syncStates();

  function openContact(quote: Quote) {
    chosen = quote;
    $('[data-domain-chosen]').textContent = strings.contact.title.replace('{domain}', quote.domain);
    $('[data-domain-paid]').textContent = strings.contact.paid.replace('{price}', usd(quote.priceCents!, lang));
    $<HTMLElement>('[data-domain-public]').hidden = !/\.mx$/.test(quote.domain); // .mx and .com.mx have no WHOIS privacy
    if (!input('email').value && page.email) input('email').value = page.email;
    contactError.textContent = '';
    view('contact');
    input('firstName').focus();
  }

  $<HTMLButtonElement>('[data-domain-back]').onclick = () => view('search');

  const markInvalid = (fields: string[]) =>
    contactForm.querySelectorAll<HTMLInputElement>('[data-field]').forEach((field) => field.setAttribute('aria-invalid', String(fields.includes(field.dataset.field!))));

  contactForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!chosen) return;
    const empty = [...contactForm.querySelectorAll<HTMLInputElement>('[data-field]')].filter((field) => !field.value.trim()).map((field) => field.dataset.field!);
    const phone = fullNumber(country.value, input('phone').value);
    if (!phone) empty.push('phone');
    markInvalid(empty);
    if (empty.length || !input('agree').checked) {
      contactError.textContent = strings.contact.fieldError;
      return;
    }
    const value = (name: string) => input(name).value.trim();
    const contact = {
      firstName: value('firstName'),
      lastName: value('lastName'),
      email: value('email'),
      phone,
      address: value('address'),
      city: value('city'),
      state: value('state'),
      postalCode: value('postalCode'),
      country: country.value,
    };
    const submit = $<HTMLButtonElement>('[data-domain-submit]');
    submit.disabled = true;
    submit.textContent = strings.contact.working;
    try {
      const { status, body } = await api<{ domain?: DomainView; error?: string; fields?: string[] }>('/me/domain', 'POST', { domain: chosen.domain, contact });
      if (status === 201 && body.domain) return showOwned(body.domain);
      if (status === 400 && body.fields) {
        markInvalid(body.fields);
        contactError.textContent = strings.contact.fieldError;
        return;
      }
      contactError.textContent = strings.errors[body.error ?? 'registrar'] ?? strings.errors.registrar!;
    } catch {
      contactError.textContent = strings.errors.registrar!;
    } finally {
      submit.disabled = false;
      submit.textContent = strings.contact.submit;
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
      page = { registerOpen: false, tlds: [] };
    }
    if (page.domain) return showOwned(page.domain);
    $<HTMLElement>('[data-domain-closed]').hidden = page.registerOpen;
    view('search');
    const q = searchForm.elements.namedItem('q') as HTMLInputElement;
    if (!q.value) {
      q.value = slug;
      searchForm.requestSubmit();
    }
  }
  void load();
}
