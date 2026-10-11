// The header's "Entraste como <email> · Salir" (AccountBar.astro), for an owner signed in through "Mis páginas web".
// "Salir" ends the session in this browser and goes back to "Mis páginas web", which then asks for the email again.
import { api } from './jobs';
import { readSession, saveSession } from './session';

const bar = document.querySelector<HTMLElement>('[data-account]');

export function showAccount(email: string) {
  if (!bar) return;
  bar.querySelector('[data-account-email]')!.textContent = email;
  bar.hidden = false;
}

bar?.querySelector<HTMLButtonElement>('[data-account-signout]')?.addEventListener('click', () => {
  saveSession(undefined);
  location.href = bar.dataset.signOutTo ?? '/';
});

/** For pages that don't load the account themselves: shows it when this browser has a session. */
export async function loadAccount() {
  const session = readSession();
  if (!session) return;
  try {
    const { status, body } = await api<{ email: string }>('/account', { headers: { authorization: `Bearer ${session.token}` } });
    if (status === 200) showAccount(body.email);
  } catch {
    // No bar: nothing else depends on it.
  }
}
