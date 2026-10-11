// "Mi sitio": the owner's page. The magic-link token arrives in the URL hash (owner-token.ts keeps it and takes it
// out of the address) and is sent as a Bearer token.
// Three tabs: the current draft; the chat that changes it (texts, contact details, undo, a redesign), with the
// QR that opens the same chat on the owner's phone; and the owner's own domain (domain.ts). The preview follows
// every change live. And delete.
import { loadAccount } from './account';
import { api as apiCall, apiUrl } from './jobs';
import { startChat, type ChatStrings } from './chat-thread';
import { startDomainTab, type DomainStrings } from './domain';
import { qrCode } from './live-preview';
import { forgetOwnerTokens, ownerHash, ownerToken, tokenHash } from './owner-token';

interface View {
  slug: string;
  status: string;
  draftUrl?: string;
  previewUrl?: string;
  businessName?: string;
}
type Message = { title: string; text: string };
interface Strings {
  noToken: Message;
  badToken: Message;
  limited: Message;
  deleted: Message;
  heading: string;
  error: string;
  deleteConfirm: string;
  previewPath: string;
  chatPath: string;
  qr: { title: string; updated: string };
  chat: ChatStrings;
  domain: DomainStrings;
  lang: string;
}

const root = document.getElementById('mysite') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const token = ownerToken();

const show = (state: string) => (root.dataset.state = state);

/** `recover`: no session for this site in this browser, so the card says how to get back to it. */
function showMessage(message: Message, recover = false) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  $<HTMLElement>('[data-recover]').hidden = !recover;
  show('message');
}

function notice(text: string) {
  $<HTMLElement>('[data-notice]').textContent = text;
}

const api = <T>(path: string, method = 'GET', body?: unknown) =>
  apiCall<T>(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

let slug = '';
let domainStarted = false;

function fill(view: View) {
  if (!view.draftUrl) return showMessage(strings.badToken, true);
  slug = view.slug;
  $('[data-business]').textContent = view.businessName ?? strings.heading;
  $('[data-chrome-name]').textContent = view.businessName ?? view.slug;
  const frame = $<HTMLIFrameElement>('.device iframe');
  if (frame.src !== view.draftUrl) frame.src = view.draftUrl;
  $<HTMLAnchorElement>('[data-draft-link]').href = `${strings.previewPath}${ownerHash()}`;
  showChatHandoff();
  showLater(view.slug);
  $<HTMLButtonElement>('[data-delete]').onclick = async () => {
    if (window.prompt(`${strings.deleteConfirm} ${view.slug}`) !== view.slug) return;
    const { status } = await api('/me', 'DELETE');
    if (status !== 200) return;
    forgetOwnerTokens({ slug: view.slug });
    showMessage(strings.deleted);
  };
  show('editor');
}

/**
 * The card on how to come back later, for an owner who opened the page with a magic link (the form, the "lista"
 * email) rather than an account session from Mis páginas web (`<slug>.@…`).
 */
function showLater(site: string) {
  $<HTMLElement>('[data-later]').hidden = token.slice(site.length + 1).startsWith('@');
}

/** The QR code opens the same chat on the owner's phone. */
function showChatHandoff() {
  const chatLink = `${location.origin}${strings.chatPath}${tokenHash()}`;
  $<HTMLElement>('[data-qr]').replaceChildren(qrCode(chatLink, strings.qr.title));
}

/**
 * The chat in the second tab. Its polls carry the current draft, so the preview follows every change made here
 * or on the phone.
 */
function startSiteChat() {
  let current = '';
  startChat($('[data-chat]'), {
    token,
    strings: strings.chat,
    scroll: 'box',
    previewLink: () => `${strings.previewPath}${ownerHash()}`,
    onView(view) {
      if (!view.draftUrl || view.draftUrl === current) return;
      const first = !current;
      current = view.draftUrl;
      if (first) return;
      $<HTMLIFrameElement>('.device iframe').src = current;
      notice(strings.qr.updated);
    },
    // Mi sitio checks the token itself (GET /me) and shows its own message.
    onNote() {},
  });
}

async function load() {
  if (!token || !apiUrl) return showMessage(strings.noToken, !!apiUrl);
  try {
    const { status, body } = await api<View>('/me');
    if (status === 429) return showMessage(strings.limited);
    if (status !== 200) return showMessage(strings.badToken, true);
    fill(body);
    startSiteChat();
    void loadAccount();
  } catch {
    showMessage({ title: strings.error, text: '' });
  }
}

// Tabs: the preview gets the whole width; the chat has its own tab.
const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((tab) => getComputedStyle(tab).display !== 'none'); // global.css may hide one
function showTab(name: string, focus = false) {
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $<HTMLElement>(`[data-panel="${tab.dataset.tab}"]`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  $<HTMLElement>('[data-viewport]').hidden = name !== 'preview';
  // The chat loads while its tab is hidden, so it can only show the latest message once the tab is open.
  if (name === 'change') {
    const thread = $<HTMLElement>('[data-thread]');
    thread.scrollTop = thread.scrollHeight;
  }
  if (name === 'domain' && !domainStarted && slug) {
    domainStarted = true;
    startDomainTab($('[data-panel="domain"]'), { api, strings: strings.domain, lang: strings.lang, slug });
  }
}
tabs.forEach((tab, i) => {
  tab.onclick = () => showTab(tab.dataset.tab!);
  tab.onkeydown = (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step) showTab(tabs[(i + step + tabs.length) % tabs.length]!.dataset.tab!, true);
  };
});

function setViewport(width: string) {
  root.querySelectorAll<HTMLButtonElement>('.viewport button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.width === width)));
  $<HTMLElement>('.device').dataset.width = width;
}
root.querySelectorAll<HTMLButtonElement>('.viewport button').forEach((button) => (button.onclick = () => setViewport(button.dataset.width!)));
// Phone width first on small screens, where the desktop preview would not fit.
if (window.matchMedia('(max-width: 48rem)').matches) setViewport('phone');

void load();

export {};
