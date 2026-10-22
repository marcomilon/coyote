// The header's country picker (SiteHeader.astro): it switches the prices on the page ([data-country] elements), the
// language (Brasil opens the Portuguese page) and tú or vos. It starts on the saved choice, else the visitor's country
// from /geo (phone.ts detectCountry). Without this script the page shows its default country.
import { VOSEO_COUNTRIES } from '../../../services/generator/src/core/i18n';
import { detectCountry } from './phone';

const KEY = 'ventas314.country';

/**
 * The chosen country, for CloudFront: cf-app-rewrite.js uses it instead of the detected one to pick the tú or vos
 * pages (PLAN.md "Spanish with vos"). Our only cookie; it holds just the country code.
 */
function rememberCountry(code: string) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `country=${code}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

// The country menu's options (SiteHeader.astro: the desktop dropdown and the drawer's list, so each code is there twice).
const options = [...document.querySelectorAll<HTMLButtonElement>('[data-country-option]')];
if (options.length) {
  const codes = options.map((o) => o.dataset.countryOption!);
  let current = options.find((o) => o.getAttribute('aria-current') === 'true')?.dataset.countryOption ?? '';
  const show = (code: string) => {
    current = code;
    document.querySelectorAll<HTMLElement>('[data-country]').forEach((el) => {
      el.hidden = el.dataset.country !== code;
    });
    const chosen = options.find((o) => o.dataset.countryOption === code)!;
    for (const o of options) {
      if (o.dataset.countryOption === code) o.setAttribute('aria-current', 'true');
      else o.removeAttribute('aria-current');
    }
    document.querySelectorAll('[data-country-flag]').forEach((el) => (el.textContent = chosen.dataset.flag ?? ''));
    document.querySelectorAll('[data-country-code]').forEach((el) => (el.textContent = code));
    document.querySelectorAll('[data-country-name]').forEach((el) => (el.textContent = chosen.dataset.name ?? ''));
  };
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: guess again on every visit.
  }
  let touched = false;
  const start = (code: string | null) => {
    if (code && codes.includes(code) && code !== current && !touched) show(code);
  };
  // The visitor's own choice first; otherwise the country CloudFront sees (not saved: only a choice is).
  if (saved && codes.includes(saved)) {
    start(saved);
    rememberCountry(saved); // a choice made before the cookie existed
  }
  else void detectCountry().then(start);
  const choose = (code: string) => {
    touched = true;
    show(code);
    try {
      localStorage.setItem(KEY, code);
    } catch {
      // Not saved; the choice still applies on this page.
    }
    rememberCountry(code);
    // The page follows the chosen country's language: Brasil opens the Portuguese page, any other country the Spanish
    // one (the saved choice makes it start on that country there). Only on a choice, never on the guess.
    const want = code === 'BR' ? 'pt' : 'es';
    const other = document.documentElement.dataset.alternate; // this page in the other language (Layout.astro)
    if (!document.documentElement.lang.startsWith(want) && other) {
      location.href = other;
      return;
    }
    // Spanish with tú or vos: CloudFront serves the other version on a reload, now that the cookie names the country.
    const vos = (VOSEO_COUNTRIES as readonly string[]).includes(code);
    if (want === 'es' && vos !== (document.documentElement.dataset.voice === 'vos')) location.reload();
  };
  for (const o of options) o.addEventListener('click', () => choose(o.dataset.countryOption!));
}
