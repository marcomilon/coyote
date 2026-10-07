// "Mis sitios": every site made with one email. The owner asks for a sign-in link by email; the link opens a
// session kept in this browser. A site is reached with `<slug>.<session>`, the shape of a magic link, so the QR,
// Mi sitio, and the chat work with it as they do with the link shown at creation.
import { api as apiCall, apiUrl } from './jobs';
import { followDraft, qrCode } from './live-preview';
import { readSession, saveSession, type Session } from './session';

interface Site {
  slug: string;
  businessName: string;
  createdAt: number;
  draftUrl: string;
  /** Stable: always the current version. */
  previewUrl: string;
}
type Note = { title: string; text: string };
interface Strings {
  lang: 'es' | 'pt';
  chatPath: string;
  mySitePath: string;
  previewPath: string;
  sent: Note;
  badLink: Note;
  unavailable: string;
  error: string;
  invalid: string;
  created: string;
  qr: { title: string; updated: string };
}
const root = document.getElementById('mysites') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const form = $<HTMLFormElement>('form[data-signin]');

const show = (state: string) => (root.dataset.state = state);

function showNote(note: Note) {
  $('[data-message-title]').textContent = note.title;
  $('[data-message-text]').textContent = note.text;
  show('message');
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let stopFollowing: (() => void) | undefined;

function select(site: Site, session: Session, button: HTMLButtonElement) {
  root.querySelectorAll('[data-site-list] button').forEach((b) => b.setAttribute('aria-current', String(b === button)));
  const hash = `#token=${encodeURIComponent(`${site.slug}.${session.token}`)}`;
  const chatLink = `${location.origin}${strings.chatPath}${hash}`;
  $('[data-detail-name]').textContent = site.businessName;
  $<HTMLAnchorElement>('[data-open]').href = `${strings.previewPath}${hash}`;
  $<HTMLAnchorElement>('[data-mysite]').href = `${strings.mySitePath}${hash}`;
  $<HTMLAnchorElement>('[data-chat-open]').href = chatLink;
  $('[data-qr]').replaceChildren(qrCode(chatLink, strings.qr.title));
  const frame = $<HTMLIFrameElement>('[data-detail] iframe');
  frame.src = site.draftUrl;
  $<HTMLElement>('[data-detail]').hidden = false;
  stopFollowing?.();
  stopFollowing = followDraft(`${site.slug}.${session.token}`, site.draftUrl, (next) => {
    site.draftUrl = next;
    frame.src = next;
    const updated = $<HTMLElement>('[data-updated]');
    updated.textContent = strings.qr.updated;
    window.setTimeout(() => (updated.textContent = ''), 4000);
  });
}

function renderSites(email: string, sites: Site[], session: Session, selected?: string) {
  $('[data-email]').textContent = email;
  $<HTMLElement>('[data-empty]').hidden = sites.length > 0;
  const date = new Intl.DateTimeFormat(strings.lang === 'pt' ? 'pt-BR' : 'es-419', { dateStyle: 'medium' });
  const buttons = sites.map((site) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'site-card' });
    const name = Object.assign(document.createElement('b'), { textContent: site.businessName });
    const when = Object.assign(document.createElement('span'), { textContent: `${strings.created} ${date.format(site.createdAt)}` });
    button.append(name, when);
    button.onclick = () => select(site, session, button);
    const li = document.createElement('li');
    li.append(button);
    return { site, button, li };
  });
  $('[data-site-list]').replaceChildren(...buttons.map((b) => b.li));
  show('editor');
  const first = buttons.find((b) => b.site.slug === selected) ?? buttons[0];
  if (first) select(first.site, session, first.button);
}

async function load() {
  if (!apiUrl) return showNote({ title: strings.error, text: '' });
  const params = new URLSearchParams(location.hash.slice(1));
  const login = params.get('login');
  const selected = params.get('site') ?? undefined;
  if (login) {
    // The link works once: take it out of the address bar and history right away.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const { status, body } = await apiCall<Session>('/account/session', json({ login }));
      if (status !== 200) return showNote(strings.badLink);
      saveSession(body);
    } catch {
      return showNote({ title: strings.error, text: '' });
    }
  }
  const session = readSession();
  if (!session) return show('form');
  try {
    const { status, body } = await apiCall<{ email: string; sites: Site[] }>('/account', { headers: { authorization: `Bearer ${session.token}` } });
    if (status === 401) {
      saveSession(undefined);
      return show('form');
    }
    if (status !== 200) return showNote({ title: strings.error, text: '' });
    renderSites(body.email, body.sites, session, selected);
  } catch {
    showNote({ title: strings.error, text: '' });
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
  const error = $('[data-error]');
  error.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void (error.textContent = strings.invalid);
  const button = form.querySelector('button') as HTMLButtonElement;
  button.disabled = true;
  try {
    const { status } = await apiCall('/account/login', json({ email, lang: strings.lang }));
    if (status === 202) return showNote(strings.sent);
    error.textContent = status === 400 ? strings.invalid : status === 503 ? strings.unavailable : strings.error;
  } catch {
    error.textContent = strings.error;
  } finally {
    button.disabled = false;
  }
});

$<HTMLButtonElement>('[data-another]').onclick = () => show('form');
$<HTMLButtonElement>('[data-signout]').onclick = () => {
  stopFollowing?.();
  saveSession(undefined);
  show('form');
};

void load();

export {};
