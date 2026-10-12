// "Mi sitio": the owner's page. The magic-link token arrives in the URL hash (owner-token.ts keeps it and takes it
// out of the address) and is sent as a Bearer token.
// Four tabs: the current draft; the chat that changes it (texts, contact details, undo, a redesign), with the
// QR that opens the same chat on the owner's phone; the owner's logo and photos; and the owner's own domain
// (domain.ts). The preview follows every change live. And delete.
import { loadAccount } from './account';
import { api as apiCall, apiUrl } from './jobs';
import { startChat, type ChatStrings } from './chat-thread';
import { startDomainTab, type DomainStrings } from './domain';
import { qrCode } from './live-preview';
import { captionField, captionsOf, showThumbs, UploadLimitError, uploadImages } from './upload';
import { forgetOwnerTokens, ownerHash, ownerToken, tokenHash } from './owner-token';

interface View {
  slug: string;
  status: string;
  draftUrl?: string;
  previewUrl?: string;
  businessName?: string;
  images?: { logo?: SiteImage; photos: SiteImage[] };
}
interface SiteImage {
  file: string;
  url: string;
  caption?: string;
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
  photos: PhotoStrings;
  lang: string;
}
interface PhotoStrings {
  caption: { label: string; placeholder: string };
  remove: string;
  keep: string;
  saving: string;
  save: string;
  started: string;
  busy: string;
  tooMany: string;
  notImage: string;
  failed: string;
  limited: string;
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
  root.querySelectorAll<HTMLAnchorElement>('[data-draft-link]').forEach((link) => (link.href = `${strings.previewPath}${ownerHash()}`));
  showChatHandoff();
  showLater(view.slug);
  showPhotos(view.images);
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
      // A redesign may have changed the photos.
      void api<View>('/me').then(({ status, body }) => status === 200 && showPhotos(body.images));
    },
    // Mi sitio checks the token itself (GET /me) and shows its own message.
    onNote() {},
  });
}

// Tus fotos: the current logo and photos, each with a button to take it out and (photos) what it shows; new files
// are picked below them.
const MAX_PHOTOS = 6; // as in services/generator/src/core/uploads.ts
const photosForm = $<HTMLFormElement>('[data-photos-form]');
const logoInput = photosForm.elements.namedItem('logo') as HTMLInputElement;
const photosInput = photosForm.elements.namedItem('photos') as HTMLInputElement;
const removed = new Set<string>();
/** Descriptions the owner changed, by file. */
const described = new Map<string, string>();
let images: View['images'];

function photoError(text: string) {
  $('[data-photos-error]').textContent = text;
}

function showPhotos(next: View['images']) {
  images = next;
  removed.clear();
  described.clear();
  const item = (image: SiteImage, withCaption: boolean) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = '';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = strings.photos.remove;
    toggle.setAttribute('aria-pressed', 'false');
    toggle.onclick = () => {
      const out = !removed.delete(image.file);
      if (out) removed.add(image.file);
      li.toggleAttribute('data-removed', out);
      toggle.textContent = out ? strings.photos.keep : strings.photos.remove;
      toggle.setAttribute('aria-pressed', String(out));
      photosChanged();
    };
    const frame = document.createElement('div');
    frame.className = 'thumb';
    frame.append(img, toggle);
    li.append(frame);
    if (withCaption) {
      li.append(
        captionField(strings.photos.caption, image.caption ?? '', (value) => {
          if (value.trim() === (image.caption ?? '')) described.delete(image.file);
          else described.set(image.file, value.trim());
          photosChanged();
        }),
      );
    }
    return li;
  };
  $('[data-current="logo"]').replaceChildren(...(next?.logo ? [item(next.logo, false)] : []));
  $('[data-current="photos"]').replaceChildren(...(next?.photos ?? []).map((photo) => item(photo, true)));
  $<HTMLElement>('[data-no-photos]').hidden = (next?.photos.length ?? 0) > 0;
  const label = $<HTMLElement>('[data-logo-label]');
  label.textContent = next?.logo ? label.dataset.change! : label.dataset.add!;
  photosChanged();
}

/** The photos the page would have after saving, and whether there is anything to save. */
function photosChanged() {
  const kept = (images?.photos ?? []).filter((photo) => !removed.has(photo.file)).length;
  const added = photosInput.files?.length ?? 0;
  photoError(kept + added > MAX_PHOTOS ? strings.photos.tooMany : '');
  $<HTMLButtonElement>('[data-photos-save]').disabled = kept + added > MAX_PHOTOS || (removed.size === 0 && described.size === 0 && added === 0 && !logoInput.files?.length);
}

const thumbStrings = (name: string) => ({ remove: strings.photos.remove, ...(name === 'photos' && { caption: strings.photos.caption }) });

for (const input of [logoInput, photosInput]) {
  const name = input.name;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    const kept = files.filter((file) => file.type.startsWith('image/')).slice(0, name === 'logo' ? 1 : MAX_PHOTOS);
    if (kept.length < files.length) {
      const transfer = new DataTransfer();
      kept.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
    }
    showThumbs(input, $(`[data-thumbs="${name}"]`), thumbStrings(name), photosChanged);
    photosChanged();
    if (files.some((file) => !file.type.startsWith('image/'))) photoError(strings.photos.notImage);
  });
}

photosForm.onsubmit = async (event) => {
  event.preventDefault();
  const save = $<HTMLButtonElement>('[data-photos-save]');
  const logo = logoInput.files?.[0];
  const photos = [...(photosInput.files ?? [])];
  save.disabled = true;
  save.textContent = strings.photos.saving;
  photoError('');
  try {
    const uploadId = logo || photos.length > 0 ? await uploadImages(apiUrl, logo, photos) : undefined;
    const newCaptions = captionsOf(photosInput);
    const captions = Object.fromEntries([...described].filter(([file]) => !removed.has(file)));
    const { status } = await api('/me/edit', 'POST', {
      ...(uploadId && { uploadId }),
      ...(uploadId && newCaptions.some(Boolean) && { newCaptions }),
      ...(removed.size > 0 && { removePhotos: [...removed] }),
      ...(Object.keys(captions).length > 0 && { captions }),
    });
    if (status === 202) {
      for (const input of [logoInput, photosInput]) {
        input.value = '';
        showThumbs(input, $(`[data-thumbs="${input.name}"]`), thumbStrings(input.name));
      }
      showPhotos(images);
      notice(strings.photos.started);
      showTab('preview');
    } else photoError(status === 409 ? strings.photos.busy : status === 429 ? strings.photos.limited : strings.photos.failed);
  } catch (error) {
    photoError(error instanceof UploadLimitError ? strings.photos.limited : strings.photos.failed);
  } finally {
    save.textContent = strings.photos.save;
    photosChanged();
  }
};

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
