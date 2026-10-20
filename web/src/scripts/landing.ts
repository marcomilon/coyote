// Home page: the country picker (TLD), the hero's example tabs, the links to the example sites, and Paddle's
// payment links (paddle.ts openLinkedCheckout).
// The picker starts on the saved choice, else the visitor's country from /geo (phone.ts detectCountry).
// The page is complete without this script: it renders the default country and the first example.
// The FAQ needs no script: <details name="faq"> keeps one answer open at a time.
import { VOSEO_COUNTRIES } from '../../../services/generator/src/core/i18n';
import { detectCountry } from './phone';
import { openLinkedCheckout } from './paddle';

const KEY = 'ventas314.country';

/**
 * The chosen country, for CloudFront: cf-app-rewrite.js uses it instead of the detected one to pick the tú or vos
 * pages (PLAN.md "Spanish with vos"). Our only cookie; it holds just the country code.
 */
function rememberCountry(code: string) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `country=${code}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

const picker = document.querySelector<HTMLSelectElement>('[data-country-select]');
if (picker) {
  const codes = [...picker.options].map((o) => o.value);
  const show = (code: string) => {
    document.querySelectorAll<HTMLElement>('[data-country]').forEach((el) => {
      el.hidden = el.dataset.country !== code;
    });
  };
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: guess again on every visit.
  }
  let touched = false;
  const start = (code: string | null) => {
    if (code && codes.includes(code) && code !== picker.value && !touched) {
      picker.value = code;
      show(code);
    }
  };
  // The visitor's own choice first; otherwise the country CloudFront sees (not saved: only a choice is).
  if (saved && codes.includes(saved)) {
    start(saved);
    rememberCountry(saved); // a choice made before the cookie existed
  }
  else void detectCountry().then(start);
  picker.addEventListener('change', () => {
    touched = true;
    show(picker.value);
    try {
      localStorage.setItem(KEY, picker.value);
    } catch {
      // Not saved; the choice still applies on this page.
    }
    rememberCountry(picker.value);
    // The page follows the chosen country's language: Brasil opens the Portuguese page, any other country the Spanish
    // one (the saved choice makes it start on that country there). Only on a choice, never on the guess.
    const want = picker.value === 'BR' ? 'pt' : 'es';
    const other = document.documentElement.dataset.alternate; // this page in the other language (Layout.astro)
    if (!document.documentElement.lang.startsWith(want) && other) {
      location.href = other;
      return;
    }
    // Spanish with tú or vos: CloudFront serves the other version on a reload, now that the cookie names the country.
    const vos = (VOSEO_COUNTRIES as readonly string[]).includes(picker.value);
    if (want === 'es' && vos !== (document.documentElement.dataset.voice === 'vos')) location.reload();
  });
}

// The hero's example tabs. With this script the screens are stacked in the phone and the chosen one fades in
// (CSS .phone.fade), on its own every 4 s until the visitor picks one; without it only the first screen shows.
const tabs = document.querySelector<HTMLElement>('[data-example-tabs]');
const phone = document.querySelector<HTMLElement>('.phone');
if (tabs && phone) {
  const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('button')];
  const screenOf = (button: HTMLButtonElement) => document.getElementById(button.getAttribute('aria-controls') ?? '');
  const select = (chosen: HTMLButtonElement) => {
    for (const button of buttons) {
      const on = button === chosen;
      button.setAttribute('aria-pressed', String(on));
      const screen = screenOf(button);
      if (!screen) continue;
      screen.classList.toggle('on', on);
      screen.inert = !on;
      screen.setAttribute('aria-hidden', String(!on));
    }
  };
  // Every 4 s the next example fades in. It stops for good once the visitor picks one, waits while the pointer or
  // the keyboard is on the examples, and never starts for visitors who ask for reduced motion.
  let timer: number | undefined;
  let paused = false;
  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
  };
  const next = () => {
    if (paused || document.hidden) return;
    const current = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    select(buttons[(current + 1) % buttons.length]!);
  };
  for (const button of buttons) {
    const screen = screenOf(button);
    if (screen) screen.hidden = false;
    button.addEventListener('click', () => {
      stop();
      select(button);
    });
  }
  phone.classList.add('fade');
  select(buttons.find((b) => b.getAttribute('aria-pressed') === 'true') ?? buttons[0]!);
  tabs.hidden = false;
  const showcase = phone.parentElement ?? phone;
  showcase.addEventListener('pointerenter', () => (paused = true));
  showcase.addEventListener('pointerleave', () => (paused = false));
  showcase.addEventListener('focusin', () => (paused = true));
  showcase.addEventListener('focusout', () => (paused = false));
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer = window.setInterval(next, 4000);
}

// The example cards' links (screenshot and "Abre este ejemplo"), from config.js. Without a URL (no config, unknown
// slug) a card stays a plain picture and its link stays hidden.
const examples = window.COYOTE_CONFIG?.examples ?? {};
document.querySelectorAll<HTMLAnchorElement>('a[data-example]').forEach((link) => {
  const url = examples[link.dataset.example ?? ''];
  if (!url) return;
  link.href = url;
  link.hidden = false;
});

openLinkedCheckout();
