// "Mi sitio": the owner's page. The magic-link token arrives in the URL hash (owner-token.ts keeps it and takes it
// out of the address) and is sent as a Bearer token.
// Five tabs: the current draft; the chat that changes it (texts, contact details, undo, a redesign), with the
// QR that opens the same chat on the owner's phone; every text on the page, to change directly; the owner's logo
// and photos; and the owner's own domain (domain.ts). The preview follows every change live. And delete.
import { showSupport } from './support';
import { loadAccount } from './account';
import { api as apiCall, apiUrl } from './jobs';
import { startChat, type ChatStrings } from './chat-thread';
import { startDomainTab, type DomainStrings } from './domain';
import { qrCode } from './live-preview';
import { captionField, captionsOf, showThumbs, UploadLimitError, uploadImages } from './upload';
import { forgetOwnerTokens, ownerHash, ownerToken, tokenHash } from './owner-token';
import { buyDesigns, checkoutAvailable } from './paddle';

interface View {
  slug: string;
  status: string;
  draftUrl?: string;
  previewUrl?: string;
  businessName?: string;
  images?: { logo?: SiteImage; photos: SiteImage[] };
  /** Photos the page writer made that the page shows. */
  made?: { file: string; url: string }[];
  texts?: PageText[];
  /** Free designs (paid-tier page writes) the owner has left; undefined when there is no limit. */
  designsLeft?: number;
  /** Every design the page writer made, oldest first (Mi sitio → Diseños). */
  designs?: DesignView[];
  /** Too many refused requests: every change answers 423 until an admin lifts it. */
  frozen?: boolean;
}
interface DesignView {
  id: string;
  at: number;
  kind: 'create' | 'redesign';
  request?: string;
  draftUrl: string;
  current: boolean;
}
/** As services/generator/src/core/page-texts.ts sends it. */
interface PageText {
  id: number;
  text: string;
  group?: string;
  kind?: 'title' | 'description';
  role?: string;
  card?: number;
  locked?: true;
}
interface SiteImage {
  file: string;
  url: string;
  caption?: string;
}
type Message = { title: string; text: string };
interface Strings {
  designsOut: { opening: string; waiting: string; done: string; late: string; failed: string };
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
  texts: TextStrings;
  designs: DesignStrings;
  frozen: Message;
  lang: string;
}
interface DesignStrings {
  name: string;
  first: string;
  inUse: string;
  view: string;
  use: string;
  using: string;
  used: string;
  busy: string;
  failed: string;
}
interface TextStrings {
  top: string;
  search: string;
  title: string;
  description: string;
  roles: Record<string, string>;
  locked: string;
  save: string;
  saving: string;
  saved: string;
  empty: string;
  stale: string;
  busy: string;
  rejected: string;
  failed: string;
  limited: string;
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
  noDesigns: string;
  made: { replace: string; other: string; keep: string; save: string; started: string };
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

/** Mi sitio → Diseños: each design, the one in use marked; "Ver" shows one below, "Usar" makes it the site's (no model call). */
function showDesigns(designs: DesignView[]) {
  const g = strings.designs;
  const list = $<HTMLOListElement>('[data-designs]');
  const view = $<HTMLElement>('[data-design-view]');
  const message = (text: string) => ($<HTMLElement>('[data-designs-notice]').textContent = text);
  const date = (at: number) => new Date(at).toLocaleDateString(strings.lang === 'pt' ? 'pt-BR' : 'es-419', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const button = (text: string, className: string, onclick: () => void) => {
    const b = document.createElement('button');
    Object.assign(b, { type: 'button', className, textContent: text, onclick });
    return b;
  };
  list.replaceChildren(
    ...designs.map((design, i) => {
      const li = document.createElement('li');
      li.toggleAttribute('data-current', design.current);
      const what = document.createElement('div');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${g.name} ${i + 1}`;
      if (design.current) {
        const badge = document.createElement('span');
        Object.assign(badge, { className: 'badge', textContent: g.inUse });
        name.append(badge);
      }
      const about = document.createElement('small');
      about.textContent = `${date(design.at)} · ${design.kind === 'create' ? g.first : `«${design.request ?? ''}»`}`;
      what.append(name, about);
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        button(g.view, 'btn small ghost', () => {
          view.querySelector('iframe')!.src = design.draftUrl;
          view.hidden = false;
          view.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }),
      );
      if (!design.current) {
        const use = button(g.use, 'btn small', async () => {
          use.disabled = true;
          use.textContent = g.using;
          message('');
          try {
            const { status, body } = await api<View>('/me/design', 'POST', { design: design.id });
            if (status === 200) {
              view.hidden = true;
              fill(body);
              notice(g.used);
              return showTab('preview');
            }
            if (status === 423) showFrozen(true);
            message(status === 423 ? strings.frozen.title : status === 409 ? g.busy : g.failed);
          } catch {
            message(g.failed);
          }
          use.disabled = false;
          use.textContent = g.use;
        });
        actions.append(use);
      }
      li.append(what, actions);
      return li;
    }),
  );
}

/** The banner for a frozen account (a 423 from any change shows it too). */
function showFrozen(frozen: boolean) {
  $<HTMLElement>('[data-frozen]').hidden = !frozen;
  if (frozen) showSupport($('[data-frozen] [data-support]'));
}

/** The banner for an owner whose designs are used up (a 402 from a redesign shows it too), with the pack to buy. */
function showDesignsOut(out: boolean) {
  $<HTMLElement>('[data-designs-out]').hidden = !out;
  $<HTMLElement>('[data-buy-designs]').hidden = !out || !checkoutAvailable();
}

/** How long Mi sitio waits for Paddle's webhook to add the designs after a payment. */
const PAID_WAIT_MS = 60_000;

/** "Comprar 3 diseños": a transaction from our API → Paddle's overlay → GET /me until the designs arrive. */
function setUpBuyDesigns() {
  const line = $<HTMLElement>('[data-buy-designs]');
  const button = line.querySelector('button')!;
  const say = (text: string, error = false) => {
    const note = $<HTMLElement>('[data-buy-notice]');
    note.textContent = text;
    note.dataset.kind = error ? 'error' : '';
  };
  button.onclick = async () => {
    button.disabled = true;
    say(strings.designsOut.opening);
    try {
      const { status, body } = await api<{ transactionId?: string; email?: string }>('/me/checkout', 'POST', {});
      const opened = status === 200 && body?.transactionId && (await buyDesigns({ transactionId: body.transactionId, email: body.email }, strings.lang, () => void waitForDesigns()));
      say(opened ? '' : strings.designsOut.failed, !opened);
    } catch {
      say(strings.designsOut.failed, true);
    } finally {
      button.disabled = false;
    }
  };
  async function waitForDesigns() {
    say(strings.designsOut.waiting);
    button.disabled = true;
    for (const started = Date.now(); Date.now() - started < PAID_WAIT_MS; ) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { status, body } = await api<View>('/me').catch(() => ({ status: 0, body: undefined }));
      if (status === 200 && body && (body.designsLeft ?? 1) > 0) {
        button.disabled = false;
        say('');
        fill(body); // hides the banner
        notice(strings.designsOut.done);
        return;
      }
    }
    button.disabled = false;
    say(strings.designsOut.late);
  }
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
  showMade(view.made);
  showTexts(view.texts);
  showDesignsOut(view.designsLeft === 0);
  showDesigns(view.designs ?? []);
  showFrozen(view.frozen === true);
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
      // A redesign may have changed the photos, and any change the texts.
      void api<View>('/me').then(({ status, body }) => {
        if (status !== 200) return;
        showPhotos(body.images);
        if (chosen.size === 0) showMade(body.made);
        if (!textsDirty()) showTexts(body.texts);
      });
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
      // A new logo alone usually goes in with no page writer (seconds); anything else is a redesign (minutes).
      const logoOnly = logo && photos.length === 0 && removed.size === 0 && Object.keys(captions).length === 0;
      for (const input of [logoInput, photosInput]) {
        input.value = '';
        showThumbs(input, $(`[data-thumbs="${input.name}"]`), thumbStrings(input.name));
      }
      showPhotos(images);
      notice(logoOnly ? strings.photos.made.started : strings.photos.started);
      showTab('preview');
    } else {
      if (status === 402) showDesignsOut(true);
      if (status === 423) showFrozen(true);
      photoError(status === 423 ? strings.frozen.title : status === 402 ? strings.photos.noDesigns : status === 409 ? strings.photos.busy : status === 429 ? strings.photos.limited : strings.photos.failed);
    }
  } catch (error) {
    photoError(error instanceof UploadLimitError ? strings.photos.limited : strings.photos.failed);
  } finally {
    save.textContent = strings.photos.save;
    photosChanged();
  }
};

// Tus textos: every text on the page as a field, grouped under the page's headings; the title and description
// (how search engines show the page) last. Saving sends only the changed ones, with the text each had.
const textsForm = $<HTMLFormElement>('[data-texts-form]');
/** The texts as loaded, by id, and the fields showing them. */
let shownTexts = new Map<number, { text: string; field: HTMLTextAreaElement }>();

const textsDirty = () => [...shownTexts.values()].some(({ text, field }) => field.value.trim() !== text);
const textsError = (text: string) => ($('[data-texts-error]').textContent = text);

function showTexts(texts: PageText[] | undefined) {
  const x = strings.texts;
  shownTexts = new Map();
  const groups = new Map<string, HTMLFieldSetElement>();
  // Texts of one card (a numbered point, a service, a contact card) go in one box, as on the page.
  const cards = new Map<number, HTMLDivElement>();
  const groupOf = (name: string) => {
    let set = groups.get(name);
    if (!set) {
      set = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = name;
      set.append(legend);
      groups.set(name, set);
    }
    return set;
  };
  for (const entry of texts ?? []) {
    const name = entry.kind ? x.search : (entry.group ?? x.top);
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const field = document.createElement('textarea');
    field.id = `text-${entry.id}`;
    field.value = entry.text;
    field.rows = Math.min(6, Math.ceil(entry.text.length / 60));
    field.maxLength = 5000;
    field.oninput = textsChanged;
    // What the text is on the page: a heading, a button, a menu entry…
    const label = document.createElement('label');
    label.className = 'sub';
    label.htmlFor = field.id;
    label.textContent = entry.kind ? x[entry.kind] : (x.roles[entry.role ?? 'text'] ?? x.roles.text!);
    wrap.append(label, field);
    if (entry.locked) {
      field.readOnly = true;
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = x.locked;
      wrap.append(hint);
    }
    if (entry.card === undefined) groupOf(name).append(wrap);
    else {
      let card = cards.get(entry.card);
      if (!card) {
        card = document.createElement('div');
        card.className = 'text-card';
        cards.set(entry.card, card);
        groupOf(name).append(card);
      }
      card.append(wrap);
    }
    shownTexts.set(entry.id, { text: entry.text, field });
  }
  // How search engines show the page goes last.
  const search = groups.get(x.search);
  groups.delete(x.search);
  $('[data-texts]').replaceChildren(...groups.values(), ...(search ? [search] : []));
  $<HTMLElement>('[data-texts-none]').hidden = shownTexts.size > 0;
  textsForm.hidden = shownTexts.size === 0;
  textsError('');
  textsChanged();
}

function textsChanged() {
  $<HTMLButtonElement>('[data-texts-save]').disabled = !textsDirty();
}

textsForm.onsubmit = async (event) => {
  event.preventDefault();
  const x = strings.texts;
  const changed = [...shownTexts].filter(([, { text, field }]) => field.value.trim() !== text).map(([id, { text, field }]) => ({ id, from: text, to: field.value.trim() }));
  if (changed.length === 0) return;
  if (changed.some(({ to }) => !to)) return textsError(x.empty);
  const save = $<HTMLButtonElement>('[data-texts-save]');
  save.disabled = true;
  save.textContent = x.saving;
  textsError('');
  try {
    const { status, body } = await api<View & { error?: string }>('/me/edit', 'POST', { texts: changed });
    if (status === 200) {
      $<HTMLIFrameElement>('.device iframe').src = body.draftUrl!;
      showTexts(body.texts);
      notice(x.saved);
      return;
    }
    if (status === 409 && body.error === 'stale') {
      const fresh = await api<View>('/me');
      if (fresh.status === 200) showTexts(fresh.body.texts);
      return textsError(x.stale);
    }
    if (status === 423) showFrozen(true);
    textsError(status === 423 ? strings.frozen.title : status === 409 ? x.busy : status === 422 ? x.rejected : status === 429 ? x.limited : x.failed);
  } catch {
    textsError(x.failed);
  } finally {
    save.textContent = x.save;
    textsChanged();
  }
};

// Fotos creadas con IA: each made photo, with a button to pick one of the owner's photos for its place. Saving
// uploads them and swaps them in (a short job: the photos are checked, no redesign).
/** The owner's photo picked for each made photo, by the made photo's file. */
const chosen = new Map<string, { file: File; caption: string }>();

function madeError(text: string) {
  $('[data-made-error]').textContent = text;
}

function showMade(made: View['made']) {
  chosen.clear();
  madeError('');
  const list = $('[data-made]');
  for (const img of list.querySelectorAll<HTMLImageElement>('img[data-picked]')) URL.revokeObjectURL(img.src);
  $<HTMLElement>('[data-made-section]').hidden = !made?.length;
  list.replaceChildren(
    ...(made ?? []).map(({ file, url }, i) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      const frame = document.createElement('div');
      frame.className = 'thumb';
      frame.append(img);
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.id = `made-${i}`;
      input.hidden = true;
      const pick = document.createElement('label');
      pick.className = 'linkbtn';
      pick.htmlFor = input.id;
      pick.textContent = strings.photos.made.replace;
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'linkbtn';
      keep.textContent = strings.photos.made.keep;
      keep.hidden = true;
      const caption = captionField(strings.photos.caption, '', (value) => {
        const pickedNow = chosen.get(file);
        if (pickedNow) pickedNow.caption = value.trim();
      });
      caption.hidden = true;
      const reset = () => {
        if (img.dataset.picked) URL.revokeObjectURL(img.src);
        delete img.dataset.picked;
        img.src = url;
        chosen.delete(file);
        li.removeAttribute('data-chosen');
        pick.textContent = strings.photos.made.replace;
        keep.hidden = caption.hidden = true;
        input.value = '';
        madeChanged();
      };
      input.onchange = () => {
        const picked = input.files?.[0];
        if (!picked) return;
        if (!picked.type.startsWith('image/')) return madeError(strings.photos.notImage);
        if (img.dataset.picked) URL.revokeObjectURL(img.src);
        img.src = URL.createObjectURL(picked);
        img.dataset.picked = 'yes';
        chosen.set(file, { file: picked, caption: caption.value.trim() });
        li.setAttribute('data-chosen', '');
        pick.textContent = strings.photos.made.other;
        keep.hidden = caption.hidden = false;
        madeChanged();
      };
      keep.onclick = reset;
      li.append(frame, input, pick, caption, keep);
      return li;
    }),
  );
  madeChanged();
}

function madeChanged() {
  const total = (images?.photos.length ?? 0) + chosen.size;
  madeError(total > MAX_PHOTOS ? strings.photos.tooMany : '');
  $<HTMLButtonElement>('[data-made-save]').disabled = chosen.size === 0 || total > MAX_PHOTOS;
}

$<HTMLButtonElement>('[data-made-save]').onclick = async () => {
  const save = $<HTMLButtonElement>('[data-made-save]');
  const picks = [...chosen];
  save.disabled = true;
  save.textContent = strings.photos.saving;
  madeError('');
  try {
    const uploadId = await uploadImages(apiUrl, undefined, picks.map(([, pick]) => pick.file));
    const newCaptions = picks.map(([, pick]) => pick.caption);
    const { status } = await api('/me/edit', 'POST', { uploadId, replaceMade: picks.map(([made]) => made), ...(newCaptions.some(Boolean) && { newCaptions }) });
    if (status === 202) {
      chosen.clear(); // the finished swap's view replaces the list
      notice(strings.photos.made.started);
      showTab('preview');
    } else {
      if (status === 423) showFrozen(true);
      madeError(status === 423 ? strings.frozen.title : status === 409 ? strings.photos.busy : status === 429 ? strings.photos.limited : strings.photos.failed);
    }
  } catch (error) {
    madeError(error instanceof UploadLimitError ? strings.photos.limited : strings.photos.failed);
  } finally {
    save.textContent = strings.photos.made.save;
    madeChanged();
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

setUpBuyDesigns();
void load();

export {};
