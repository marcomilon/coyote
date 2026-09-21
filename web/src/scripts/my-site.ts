// "Mi sitio": the owner's page. The magic-link token arrives in the URL hash and is sent as a Bearer token.
interface Row {
  a: string;
  b: string;
}
interface View {
  slug: string;
  status: 'published' | 'unpublished' | 'claimed';
  siteUrl: string;
  regenerationsLeft: number;
  content?: {
    headline: string;
    subhead: string;
    about: string;
    ctaText: string;
    services: { name: string; detail?: string }[];
    hours: { days: string; time: string }[];
    contact: { whatsapp: string; address?: string; instagram?: string; facebook?: string };
  };
}
type Message = { title: string; text: string };
interface Strings {
  noToken: Message;
  badToken: Message;
  deleted: Message;
  status: Record<string, string>;
  fields: { remove: string };
  save: string;
  saving: string;
  saved: string;
  rejected: string;
  invalid: string;
  error: string;
  regenerationsLeft: string;
  unpublish: string;
  republish: string;
  deleteConfirm: string;
  createPath: string;
}

const root = document.getElementById('mysite') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const form = root.querySelector('form') as HTMLFormElement;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const apiUrl = (new URLSearchParams(location.search).get('api') ?? window.COYOTE_CONFIG?.apiUrl ?? '').replace(/\/+$/, '');
const token = decodeURIComponent(/^#token=(.+)$/.exec(location.hash)?.[1] ?? '');

function showMessage(message: Message) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  root.dataset.state = 'message';
}

function notice(text: string, kind: 'ok' | 'error' = 'ok') {
  const el = $<HTMLElement>('[data-notice]');
  el.textContent = text;
  el.dataset.kind = kind;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

function addRow(list: HTMLElement, row: Row = { a: '', b: '' }) {
  const wrapper = document.createElement('div');
  for (const [key, value] of [['a', row.a], ['b', row.b]] as const) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.dataset.col = key;
    input.placeholder = list.dataset[key] ?? '';
    input.setAttribute('aria-label', input.placeholder);
    wrapper.append(input);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = strings.fields.remove;
  remove.onclick = () => wrapper.remove();
  wrapper.append(remove);
  list.append(wrapper);
}

const rows = (name: string): Row[] =>
  [...$<HTMLElement>(`[data-list="${name}"]`).children]
    .map((el) => ({ a: el.querySelector<HTMLInputElement>('[data-col="a"]')!.value.trim(), b: el.querySelector<HTMLInputElement>('[data-col="b"]')!.value.trim() }))
    .filter((row) => row.a !== '');

function fill(view: View) {
  const c = view.content;
  if (!c) return showMessage(strings.badToken);
  const set = (name: string, value = '') => ((form.elements.namedItem(name) as HTMLInputElement).value = value);
  set('headline', c.headline);
  set('subhead', c.subhead);
  set('about', c.about);
  set('ctaText', c.ctaText);
  set('whatsapp', `+${c.contact.whatsapp}`);
  set('address', c.contact.address);
  set('instagram', c.contact.instagram);
  set('facebook', c.contact.facebook);
  for (const [name, items] of [['services', c.services.map((s) => ({ a: s.name, b: s.detail ?? '' }))], ['hours', c.hours.map((h) => ({ a: h.days, b: h.time }))]] as const) {
    const list = $<HTMLElement>(`[data-list="${name}"]`);
    list.replaceChildren();
    items.forEach((row) => addRow(list, row));
  }
  const badge = $<HTMLElement>('[data-status]');
  badge.textContent = strings.status[view.status] ?? view.status;
  badge.dataset.status = view.status;
  $<HTMLAnchorElement>('[data-site-link]').href = view.siteUrl;
  $('[data-regen-left]').textContent = strings.regenerationsLeft.replace('{n}', String(view.regenerationsLeft));
  $<HTMLButtonElement>('[data-regenerate]').disabled = view.regenerationsLeft === 0;
  const toggle = $<HTMLButtonElement>('[data-toggle]');
  toggle.textContent = view.status === 'published' ? strings.unpublish : strings.republish;
  toggle.onclick = async () => {
    toggle.disabled = true;
    await api(view.status === 'published' ? '/me/unpublish' : '/me/republish', 'POST');
    toggle.disabled = false;
    void load();
  };
  $<HTMLButtonElement>('[data-delete]').onclick = async () => {
    if (window.prompt(`${strings.deleteConfirm} ${view.slug}`) !== view.slug) return;
    const { status } = await api('/me', 'DELETE');
    if (status === 200) showMessage(strings.deleted);
  };
  root.dataset.state = 'editor';
}

async function load() {
  if (!token || !apiUrl) return showMessage(strings.noToken);
  try {
    const { status, body } = await api<View>('/me');
    if (status !== 200) return showMessage(strings.badToken);
    fill(body);
  } catch {
    showMessage({ title: strings.error, text: '' });
  }
}

root.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((button) => {
  button.onclick = () => addRow($<HTMLElement>(`[data-list="${button.dataset.add}"]`));
});

$<HTMLButtonElement>('[data-regenerate]').onclick = async () => {
  const { status, body } = await api<{ jobId?: string }>('/me/regenerate', 'POST');
  // The create page shows the preview and the publish button for the new version.
  if (status === 202 && body.jobId) location.href = `${strings.createPath}#job=${body.jobId}`;
  else notice(strings.error, 'error');
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const optional = (value?: string) => value?.trim().replace(/^@/, '') || undefined;
  const patch = {
    headline: data.headline,
    subhead: data.subhead,
    about: data.about,
    ctaText: data.ctaText,
    services: rows('services').map((row) => ({ name: row.a, detail: row.b || undefined })),
    hours: rows('hours').map((row) => ({ days: row.a, time: row.b })),
    contact: { whatsapp: (data.whatsapp ?? '').replace(/\D/g, ''), address: optional(data.address), instagram: optional(data.instagram), facebook: optional(data.facebook) },
  };
  const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = strings.saving;
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  try {
    const { status, body } = await api<View & { fields?: string[] }>('/me/content', 'POST', patch);
    if (status === 200) {
      fill(body);
      notice(strings.saved);
    } else if (status === 400) {
      for (const field of body.fields ?? []) (form.elements.namedItem(field.split('.').pop() ?? '') as HTMLElement | null)?.setAttribute('aria-invalid', 'true');
      notice(strings.invalid, 'error');
    } else {
      notice(status === 422 ? strings.rejected : strings.error, 'error');
    }
  } catch {
    notice(strings.error, 'error');
  } finally {
    button.disabled = false;
    button.textContent = strings.save;
  }
});

void load();
