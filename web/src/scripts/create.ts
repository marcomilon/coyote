// The create flow: form → POST /generate → poll GET /jobs/{id} → (questions → POST /jobs/{id}/answers → poll)
// → Mi sitio, opened with the magic link. Validation uses the same zod schema as the API, so the two can never disagree.
import { ZodError } from 'zod';
import { normalizeAnswers } from '../../../services/generator/src/core/answers';
import { api, apiUrl, sendAnswers, waitForJob, type JobView } from './jobs';
import { fullNumber, setUpCountryPicker } from './phone';
import { markInvalid, readAnswers, renderQuestions, type QuestionStrings } from './questions';
import { readSession } from './session';
import { uploadImages } from './upload';

type State = 'form' | 'working' | 'questions' | 'message';
/** `action`: a button back to the form, with the owner's answers filled in again. */
type Message = { title: string; text: string; action?: string };
interface Strings {
  lang: 'es' | 'pt';
  errors: Record<string, string>;
  uploading: string;
  uploadFailed: string;
  tooManyPhotos: string;
  notImage: string;
  submit: string;
  mySitePath: string;
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
setUpCountryPicker(form.elements.namedItem('country') as HTMLSelectElement, form.elements.namedItem('whatsapp') as HTMLInputElement);
const MAX_PHOTOS = 3; // as in services/generator/src/core/uploads.ts
const questionsForm = root.querySelector('form[data-questions]') as HTMLFormElement;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;

// Character counters under the fields with a limit, so a long description isn't cut off without notice.
form.querySelectorAll<HTMLElement>('[data-count-for]').forEach((counter) => {
  const field = form.elements.namedItem(counter.dataset.countFor!) as HTMLInputElement | HTMLTextAreaElement;
  const update = () => {
    counter.textContent = `${field.value.length}/${field.maxLength}`;
    counter.classList.toggle('full', field.value.length >= field.maxLength);
  };
  field.addEventListener('input', update);
  update();
});

// Photos: images only, at most MAX_PHOTOS; extra or non-image files are dropped with a note.
for (const name of ['logo', 'photos']) {
  const input = form.elements.namedItem(name) as HTMLInputElement;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    const images = files.filter((file) => file.type.startsWith('image/'));
    const kept = images.slice(0, name === 'photos' ? MAX_PHOTOS : 1);
    $('[data-error="photos"]').textContent = images.length < files.length ? strings.notImage : kept.length < images.length ? strings.tooManyPhotos : '';
    if (kept.length < files.length) {
      const transfer = new DataTransfer();
      kept.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
    }
  });
}

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
  const back = $<HTMLButtonElement>('[data-back-to-form]');
  back.textContent = message.action ?? '';
  back.hidden = !message.action;
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
  // Start the bar again: after the questions the view comes back from display:none, and Chrome can leave it frozen.
  root.querySelectorAll<HTMLElement>('[data-view="working"] .paint').forEach((bar) => bar.getAnimations().forEach((a) => (a.cancel(), a.play())));
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

/** The magic link is handed out once. Kept for this tab, so a reload of /crear#job=… still finds it. */
const magicKey = (jobId: string) => `coyote:magic:${jobId}`;
function rememberMagic(jobId: string, job: JobView) {
  try {
    if (job.miSitioUrl) sessionStorage.setItem(magicKey(jobId), JSON.stringify({ miSitioUrl: job.miSitioUrl }));
    return JSON.parse(sessionStorage.getItem(magicKey(jobId)) ?? 'null') as { miSitioUrl: string } | null;
  } catch {
    return job.miSitioUrl ? { miSitioUrl: job.miSitioUrl } : null;
  }
}

// The owner's answers, kept for this tab until the site is ready, so a rejection or a failure can go back to the
// form filled in (the photos are not kept: a file input can't be filled from script).
const ANSWERS_KEY = 'coyote:answers';
const ANSWER_FIELDS = ['businessName', 'about', 'country', 'whatsapp', 'email', 'address', 'instagram', 'facebook', 'ownerEmail'] as const;

function keepAnswers(data: Record<string, string>) {
  try {
    sessionStorage.setItem(ANSWERS_KEY, JSON.stringify(Object.fromEntries(ANSWER_FIELDS.map((f) => [f, data[f] ?? '']))));
  } catch {
    // Storage blocked: the button still goes back to the form, empty.
  }
}

function forgetAnswers() {
  try {
    sessionStorage.removeItem(ANSWERS_KEY);
  } catch {
    // Nothing kept.
  }
}

function backToForm() {
  let kept: Record<string, string> = {};
  try {
    kept = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    // Nothing kept: the form stays as it is.
  }
  for (const field of ANSWER_FIELDS) {
    const el = form.elements.namedItem(field) as HTMLInputElement | HTMLSelectElement | null;
    if (!el || kept[field] === undefined) continue;
    el.value = kept[field];
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input')); // placeholder and counters
  }
  history.replaceState(null, '', location.pathname + location.search);
  show('form');
  (form.elements.namedItem('about') as HTMLTextAreaElement).focus({ preventScroll: true });
}
$<HTMLButtonElement>('[data-back-to-form]').onclick = backToForm;

/** The draft is ready: the owner continues on Mi sitio, which the magic link opens. */
function showDone(jobId: string, job: JobView) {
  const magic = rememberMagic(jobId, job);
  forgetAnswers();
  if (!magic) return showMessage(strings.lostLink);
  // Mi sitio on this app (localhost in development); replace() keeps this finished page out of Back.
  location.replace(`${strings.mySitePath}${new URL(magic.miSitioUrl).hash}`);
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
  const note = $('[data-close-note]');
  note.textContent = strings.canClose.replace('{email}', email || '✉');
  note.classList.add('ready');
}

const waitNote = $('[data-close-note]').textContent;

async function follow(jobId: string) {
  $('[data-close-note]').textContent = waitNote;
  $('[data-close-note]').classList.remove('ready');
  if (root.dataset.state !== 'working') show('working'); // the submit may have shown it already
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
    whatsapp: fullNumber(data.country ?? '', data.whatsapp ?? ''),
    email: data.email || undefined,
    address: data.address || undefined,
    instagram: data.instagram || undefined,
    facebook: data.facebook || undefined,
    lang: strings.lang,
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
  keepAnswers(data);

  const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  button.disabled = true;
  // Show the working view right away: /generate runs the pre-screen first and takes a few seconds.
  $('[data-close-note]').textContent = waitNote;
  show('working');
  // A field the API rejects (or a failed upload) sends the owner back to the form.
  const formErrors = (fields: string[]) => {
    show('form');
    setErrors(fields);
  };
  try {
    const logo = (form.elements.namedItem('logo') as HTMLInputElement).files?.[0];
    const photos = [...((form.elements.namedItem('photos') as HTMLInputElement).files ?? [])].slice(0, MAX_PHOTOS);
    if (logo || photos.length > 0) {
      button.textContent = strings.uploading;
      try {
        raw.uploadId = await uploadImages(apiUrl, logo, photos);
      } catch {
        button.textContent = strings.submit;
        return formErrors(['photos']);
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
    if (status === 400) return formErrors(body.fields?.length ? body.fields : ['generic']);
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
/** Signed in to "Mis sitios" in this browser: the email field starts with that account's email. */
async function emailFromSession() {
  const session = readSession();
  const field = form.elements.namedItem('ownerEmail') as HTMLInputElement;
  if (!session || !apiUrl || field.value) return;
  try {
    const { status, body } = await api<{ email?: string }>('/account', { headers: { authorization: `Bearer ${session.token}` } });
    if (status !== 200 || !body.email || field.value) return;
    field.value = body.email;
    $<HTMLElement>('[data-signed-in]').hidden = false;
  } catch {
    // Offline or a stale session: the field stays empty.
  }
}
void emailFromSession();

const resumed = /^#job=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
if (resumed && apiUrl) void follow(resumed);
