// Where owners write to us (a paused account): soporte@<domain> from config.js, none without a domain.
export const supportEmail = window.COYOTE_CONFIG?.supportEmail;

/** "<lead> soporte@…", or nothing when there is no address. */
export const supportLine = (lead: string) => (supportEmail ? ` ${lead} ${supportEmail}.` : '');

/** Fills a `[data-support]` paragraph: its lead text, then the address as a mailto link. Stays hidden with no address. */
export function showSupport(el: HTMLElement | null) {
  if (!el || !supportEmail) return;
  const link = el.querySelector('a') ?? el.appendChild(document.createElement('a'));
  link.href = `mailto:${supportEmail}`;
  link.textContent = supportEmail;
  el.hidden = false;
}
