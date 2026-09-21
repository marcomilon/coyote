// The create flow: form → POST /generate → poll GET /jobs/{id} → preview → POST /jobs/{id}/publish → link.
// Validation uses the same zod schema as the API, so the two can never disagree.
import { ZodError } from 'zod';
import { normalizeAnswers } from '../../../services/generator/src/core/answers';
import { uploadImages } from './upload';

type State = 'form' | 'working' | 'preview' | 'done' | 'message';
type Message = { title: string; text: string };
interface Strings {
  errors: Record<string, string>;
  publish: string;
  publishing: string;
  noMore: string;
  uploading: string;
  uploadFailed: string;
  submit: string;
  createPath: string;
  mySitePath: string;
  copy: string;
  copied: string;
  rejected: Message;
  rateLimited: Message;
  failed: Message;
  noApi: string;
}
interface JobView {
  status: 'PENDING' | 'DONE' | 'PUBLISHED' | 'REJECTED' | 'FAILED';
  previewUrl?: string;
  siteUrl?: string;
}

const POLL_MS = 2500;
const POLL_LIMIT_MS = 4 * 60 * 1000;

const root = document.getElementById('create') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const form = root.querySelector('form') as HTMLFormElement;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;

const apiUrl = (new URLSearchParams(location.search).get('api') ?? window.COYOTE_CONFIG?.apiUrl ?? '').replace(/\/+$/, '');

let stepTimer: number | undefined;

function show(state: State) {
  root.dataset.state = state;
  window.clearInterval(stepTimer);
  if (state === 'working') animateSteps();
  root.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function showMessage(message: Message) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  history.replaceState(null, '', location.pathname + location.search);
  show('message');
}

/** The real steps are invisible from here, so the list simply advances while we wait. */
function animateSteps() {
  const items = [...root.querySelectorAll('.worksteps li')];
  items.forEach((item, i) => item.classList.toggle('on', i === 0));
  let current = 0;
  stepTimer = window.setInterval(() => {
    if (current < items.length - 1) items[++current]?.classList.add('on');
  }, 2600);
}

function setErrors(fields: string[]) {
  root.querySelectorAll<HTMLElement>('[data-error]').forEach((el) => (el.textContent = ''));
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  for (const field of fields) {
    const target = root.querySelector<HTMLElement>(`[data-error="${field}"]`) ?? $('[data-error="form"]');
    target.textContent = strings.errors[field] ?? strings.errors.generic ?? '';
    const input = form.elements.namedItem(field.replace('contact.', ''));
    if (input instanceof HTMLElement) input.setAttribute('aria-invalid', 'true');
  }
  form.querySelector<HTMLElement>('[aria-invalid]')?.focus();
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl + path, init);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

function showJob(job: JobView, jobId: string) {
  if (job.status === 'DONE' && job.previewUrl) {
    $<HTMLIFrameElement>('iframe').src = job.previewUrl;
    $<HTMLAnchorElement>('[data-preview-link]').href = job.previewUrl;
    $<HTMLButtonElement>('[data-publish]').onclick = () => publish(jobId);
    $<HTMLButtonElement>('[data-another]').onclick = () => another(jobId);
    show('preview');
  } else if (job.status === 'PUBLISHED' && job.siteUrl) {
    const link = $<HTMLAnchorElement>('[data-site-link]');
    link.href = job.siteUrl;
    link.textContent = job.siteUrl.replace(/^https:\/\//, '');
    $<HTMLAnchorElement>('[data-site-link-button]').href = job.siteUrl;
    $<HTMLButtonElement>('[data-copy]').onclick = async (event) => {
      await navigator.clipboard.writeText(job.siteUrl!);
      const button = event.currentTarget as HTMLButtonElement;
      button.textContent = strings.copied;
      window.setTimeout(() => (button.textContent = strings.copy), 1800);
    };
    show('done');
  } else if (job.status === 'REJECTED') {
    showMessage(strings.rejected);
  } else {
    showMessage(strings.failed);
  }
}

async function poll(jobId: string) {
  show('working');
  const started = Date.now();
  while (Date.now() - started < POLL_LIMIT_MS) {
    try {
      const { status, body } = await api<JobView>(`/jobs/${jobId}`);
      if (status === 404) break;
      if (status === 200 && body.status !== 'PENDING') return showJob(body, jobId);
    } catch {
      // A dropped connection is normal on mobile: keep trying until the limit.
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
  }
  showMessage(strings.failed);
}

async function publish(jobId: string) {
  const button = $<HTMLButtonElement>('[data-publish]');
  button.disabled = true;
  button.textContent = strings.publishing;
  try {
    const { status, body } = await api<{ siteUrl?: string; miSitioUrl?: string; ownerWhatsApp?: string }>(`/jobs/${jobId}/publish`, { method: 'POST' });
    if (status === 200 && body.siteUrl) {
      if (body.miSitioUrl) showMagicLink(body.miSitioUrl, body.ownerWhatsApp);
      return showJob({ status: 'PUBLISHED', siteUrl: body.siteUrl }, jobId);
    }
    showMessage(strings.failed);
  } catch {
    button.disabled = false;
    button.textContent = strings.publish;
  }
}

/** The owner's link is returned once, on the first publish. It points at this app's "Mi sitio" page. */
function showMagicLink(miSitioUrl: string, ownerWhatsApp?: string) {
  const link = new URL(miSitioUrl);
  const local = `${location.origin}${strings.mySitePath}${link.hash}`;
  $<HTMLElement>('[data-magic]').hidden = false;
  $<HTMLAnchorElement>('[data-magic-open]').href = local;
  $<HTMLAnchorElement>('[data-magic-whatsapp]').href = `https://wa.me/${ownerWhatsApp ?? ''}?text=${encodeURIComponent(local)}`;
  $<HTMLButtonElement>('[data-magic-copy]').onclick = async (event) => {
    await navigator.clipboard.writeText(local);
    const button = event.currentTarget as HTMLButtonElement;
    const label = button.textContent;
    button.textContent = strings.copied;
    window.setTimeout(() => (button.textContent = label), 1800);
  };
}

async function another(jobId: string) {
  const button = $<HTMLButtonElement>('[data-another]');
  button.disabled = true;
  try {
    const { status, body } = await api<{ jobId?: string }>(`/jobs/${jobId}/regenerate`, { method: 'POST' });
    if (status === 202 && body.jobId) {
      history.replaceState(null, '', `#job=${body.jobId}`);
      return void poll(body.jobId);
    }
    if (status === 429) button.textContent = strings.noMore;
  } catch {
    button.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!apiUrl) return setErrors(['noApi']);

  const data = Object.fromEntries([...new FormData(form)].filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  const raw: Record<string, string | undefined> = {
    businessName: data.businessName ?? '',
    about: data.about ?? '',
    whatsapp: data.whatsapp ?? '',
    address: data.address || undefined,
    instagram: data.instagram || undefined,
    facebook: data.facebook || undefined,
    lang: data.lang,
  };
  try {
    normalizeAnswers(raw as never);
  } catch (error) {
    if (error instanceof ZodError) return setErrors([...new Set(error.issues.map((issue) => issue.path.join('.')))]);
    throw error;
  }
  setErrors([]);

  const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  button.disabled = true;
  try {
    const logo = (form.elements.namedItem('logo') as HTMLInputElement).files?.[0];
    const photos = [...((form.elements.namedItem('photos') as HTMLInputElement).files ?? [])].slice(0, 3);
    if (logo || photos.length > 0) {
      button.textContent = strings.uploading;
      try {
        raw.uploadId = await uploadImages(apiUrl, logo, photos);
      } catch {
        button.textContent = strings.submit;
        return setErrors(['photos']);
      }
    }
    const { status, body } = await api<{ jobId?: string; fields?: string[] }>('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(raw),
    });
    if (status === 202 && body.jobId) {
      // The job lives in the URL so a reload picks it up again.
      history.replaceState(null, '', `#job=${body.jobId}`);
      return void poll(body.jobId);
    }
    if (status === 400) return setErrors(body.fields?.length ? body.fields : ['generic']);
    if (status === 422) return showMessage(strings.rejected);
    if (status === 429) return showMessage(strings.rateLimited);
    showMessage(strings.failed);
  } catch {
    showMessage(strings.failed);
  } finally {
    button.disabled = false;
    button.textContent = strings.submit;
  }
});

strings.errors.noApi = strings.noApi;
strings.errors.photos = strings.uploadFailed;
const resumed = /^#job=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
if (resumed && apiUrl) void poll(resumed);
