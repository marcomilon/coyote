// Home page: the hero's example tabs, the links to the example sites, and Paddle's payment links (paddle.ts
// openLinkedCheckout). The country picker is country.ts (loaded by SiteHeader.astro).
// The page is complete without this script: it renders the default country and the first example.
// The FAQ needs no script: <details name="faq"> keeps one answer open at a time.
import { openLinkedCheckout } from './paddle';

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
