// The create flow: form → POST /generate → poll GET /jobs/{id} → (questions → POST /jobs/{id}/answers → poll)
// → the draft and the magic link. Validation uses the same zod schema as the API, so the two can never disagree.
import { ZodError } from 'zod';
import { normalizeAnswers } from '../../../services/generator/src/core/answers';
import { api, apiUrl, sendAnswers, waitForJob, type JobView } from './jobs';
import { followDraft, qrCode } from './live-preview';
import { markInvalid, readAnswers, renderQuestions, type QuestionStrings } from './questions';
import { uploadImages } from './upload';

type State = 'form' | 'working' | 'questions' | 'done' | 'message';
type Message = { title: string; text: string };
interface Strings {
  errors: Record<string, string>;
  uploading: string;
  uploadFailed: string;
  submit: string;
  mySitePath: string;
  chatPath: string;
  qr: { title: string; updated: string };
  copied: string;
  question: QuestionStrings & { invalid: string };
  rejected: Message;
  rateLimited: Message;
  failed: Message;
  lostLink: Message;
  noApi: string;
  canClose: string;
}

const root = document.getElementById('create') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const form = root.querySelector('form[data-form]') as HTMLFormElement;
const questionsForm = root.querySelector('form[data-questions]') as HTMLFormElement;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;

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

/**
 * The real steps are invisible from here, so the list advances on the usual timing (the page itself is the
 * long step, 2–4 minutes). The current step keeps pulsing and the elapsed time keeps counting until the page
 * is ready, so the wait never looks frozen.
 */
const STEP_STARTS_MS = [0, 8_000, 25_000, 50_000];

function animateSteps() {
  const items = [...root.querySelectorAll('.worksteps li')];
  const elapsed = $<HTMLElement>('[data-elapsed]');
  const started = Date.now();
  const tick = () => {
    const ms = Date.now() - started;
    const current = Math.min(items.length - 1, STEP_STARTS_MS.filter((start) => ms >= start).length - 1);
    items.forEach((item, i) => {
      item.classList.toggle('done', i < current);
      item.classList.toggle('on', i === current);
    });
    const seconds = Math.floor(ms / 1000);
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  tick();
  stepTimer = window.setInterval(tick, 1000);
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

/** The magic link is handed out once. Kept for this tab, so a reload of the result still shows it. */
const magicKey = (jobId: string) => `coyote:magic:${jobId}`;
function rememberMagic(jobId: string, job: JobView) {
  try {
    if (job.miSitioUrl) sessionStorage.setItem(magicKey(jobId), JSON.stringify({ miSitioUrl: job.miSitioUrl, ownerWhatsApp: job.ownerWhatsApp }));
    return JSON.parse(sessionStorage.getItem(magicKey(jobId)) ?? 'null') as { miSitioUrl: string; ownerWhatsApp?: string } | null;
  } catch {
    return job.miSitioUrl ? { miSitioUrl: job.miSitioUrl, ownerWhatsApp: job.ownerWhatsApp } : null;
  }
}

function copyButton(button: HTMLButtonElement, text: string) {
  button.onclick = async () => {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = strings.copied;
    window.setTimeout(() => (button.textContent = label), 1800);
  };
}

function showDone(jobId: string, job: JobView) {
  const magic = rememberMagic(jobId, job);
  if (!magic || !job.draftUrl) return showMessage(strings.lostLink);
  // The link points at this app's own Mi sitio page (localhost in development).
  const link = `${location.origin}${strings.mySitePath}${new URL(magic.miSitioUrl).hash}`;
  $<HTMLIFrameElement>('[data-view="done"] iframe').src = job.draftUrl;
  // The stable URL: a tab opened with it shows every later change on reload.
  $<HTMLAnchorElement>('[data-draft-link]').href = job.previewUrl ?? job.draftUrl;
  const box = $<HTMLAnchorElement>('[data-magic-link]');
  box.href = link;
  box.textContent = link.replace(/^https?:\/\//, '').replace(/#token=.{12}.*$/, '#token=…');
  copyButton($<HTMLButtonElement>('[data-magic-copy]'), link);
  $<HTMLAnchorElement>('[data-magic-whatsapp]').href = `https://wa.me/${magic.ownerWhatsApp ?? ''}?text=${encodeURIComponent(link)}`;
  $<HTMLAnchorElement>('[data-magic-open]').href = link;
  showChatHandoff(new URL(magic.miSitioUrl).hash, job.draftUrl);
  show('done');
}

let stopFollowing: (() => void) | undefined;

/** The QR code opens the chat on the owner's phone; this page then shows every change the chat makes. */
function showChatHandoff(hash: string, draftUrl: string) {
  const token = decodeURIComponent(/^#token=(.+)$/.exec(hash)?.[1] ?? '');
  if (!token) return;
  const chatLink = `${location.origin}${strings.chatPath}${hash}`;
  $<HTMLElement>('[data-qr]').replaceChildren(qrCode(chatLink, strings.qr.title));
  $<HTMLAnchorElement>('[data-chat-open]').href = chatLink;
  $<HTMLElement>('[data-handoff]').hidden = false;
  stopFollowing?.();
  stopFollowing = followDraft(token, draftUrl, (next) => {
    $<HTMLIFrameElement>('[data-view="done"] iframe').src = next;
    const updated = $<HTMLElement>('[data-updated]');
    updated.textContent = strings.qr.updated;
    window.setTimeout(() => (updated.textContent = ''), 4000);
  });
}

function showQuestions(jobId: string, job: JobView) {
  renderQuestions($<HTMLElement>('[data-question-list]'), job.questions ?? [], strings.question);
  const submitAnswers = async (body: Parameters<typeof sendAnswers>[1]) => {
    questionsForm.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { status, body: result } = await sendAnswers(jobId, body);
      if (status === 202) return void follow(jobId);
      if (status === 400) return markInvalid($<HTMLElement>('[data-question-list]'), result.fields ?? [], strings.question.invalid);
      if (status === 422) return showMessage(strings.rejected);
      if (status === 409) return void follow(jobId); // already answered (another tab): just wait
      showMessage(strings.failed);
    } catch {
      showMessage(strings.failed);
    } finally {
      questionsForm.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };
  questionsForm.onsubmit = (event) => {
    event.preventDefault();
    void submitAnswers({ answers: readAnswers($<HTMLElement>('[data-question-list]')) });
  };
  $<HTMLButtonElement>('[data-skip]').onclick = () => void submitAnswers({ skip: true });
  show('questions');
  $<HTMLElement>('[data-question-list] input, [data-question-list] textarea')?.focus({ preventScroll: true });
}

/** The email typed in the form, kept for this tab so a reload still names it. */
const emailKey = (jobId: string) => `coyote:email:${jobId}`;

/** Once no questions can come, the owner may leave: the ready email brings them back. */
function progress(jobId: string, job: JobView) {
  if (job.kind !== 'create' || job.stage !== 'write') return;
  let email = '';
  try {
    email = sessionStorage.getItem(emailKey(jobId)) ?? '';
  } catch {
    // Storage blocked: the note still makes sense without the address.
  }
  $('[data-close-note]').textContent = strings.canClose.replace('{email}', email || '✉');
}

const waitNote = $('[data-close-note]').textContent;

async function follow(jobId: string) {
  $('[data-close-note]').textContent = waitNote;
  show('working');
  const job = await waitForJob(jobId, (current) => progress(jobId, current));
  if (job.status === 'NEEDS_INPUT') showQuestions(jobId, job);
  else if (job.status === 'DONE') showDone(jobId, job);
  else if (job.status === 'REJECTED') showMessage(strings.rejected);
  else showMessage(strings.failed);
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
  const ownerEmail = (data.ownerEmail ?? '').trim();
  try {
    normalizeAnswers(raw as never);
  } catch (error) {
    if (error instanceof ZodError) return setErrors([...new Set(error.issues.map((issue) => issue.path.join('.'))), ...(validEmail(ownerEmail) ? [] : ['ownerEmail'])]);
    throw error;
  }
  if (!validEmail(ownerEmail)) return setErrors(['ownerEmail']);
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
      body: JSON.stringify({ ...raw, ownerEmail }),
    });
    if (status === 202 && body.jobId) {
      try {
        sessionStorage.setItem(emailKey(body.jobId), ownerEmail);
      } catch {
        // Only the "you may close" note uses it.
      }
      // The job lives in the URL so a reload picks it up again.
      history.replaceState(null, '', `#job=${body.jobId}`);
      return void follow(body.jobId);
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

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

strings.errors.noApi = strings.noApi;
strings.errors.photos = strings.uploadFailed;
const resumed = /^#job=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
if (resumed && apiUrl) void follow(resumed);
