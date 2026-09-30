// "Mi sitio": the owner's page. The magic-link token arrives in the URL hash and is sent as a Bearer token.
// Shows the current draft, takes free-text change requests (with the model's questions when it asks),
// contact changes, undo, and delete.
import { api as apiCall, apiUrl, sendAnswers, waitForJob } from './jobs';
import { markInvalid, readAnswers, renderQuestions, type QuestionStrings } from './questions';

const CONTACT_FIELDS = ['whatsapp', 'phone', 'email', 'address', 'instagram', 'facebook'] as const;
type Contact = Partial<Record<(typeof CONTACT_FIELDS)[number], string>>;

interface View {
  slug: string;
  status: string;
  draftUrl?: string;
  previewUrl?: string;
  canUndo: boolean;
  businessName?: string;
  contact?: Contact;
}
type Message = { title: string; text: string };
interface Strings {
  noToken: Message;
  badToken: Message;
  deleted: Message;
  heading: string;
  saved: string;
  contactSaved: string;
  changed: string;
  undone: string;
  rejected: string;
  invalid: string;
  error: string;
  limit: string;
  empty: string;
  deleteConfirm: string;
  question: QuestionStrings & { invalid: string };
}

const root = document.getElementById('mysite') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const editForm = $<HTMLFormElement>('form[data-edit]');
const contactForm = $<HTMLFormElement>('form[data-contact]');
const questionsForm = $<HTMLFormElement>('form[data-questions]');
const token = decodeURIComponent(/^#token=(.+)$/.exec(location.hash)?.[1] ?? '');

const show = (state: string) => (root.dataset.state = state);

function showMessage(message: Message) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  show('message');
}

function notice(text: string, kind: 'ok' | 'error' = 'ok') {
  const el = $<HTMLElement>('[data-notice]');
  el.textContent = text;
  el.dataset.kind = kind;
}

const api = <T>(path: string, method = 'GET', body?: unknown) =>
  apiCall<T>(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

function fill(view: View) {
  if (!view.draftUrl) return showMessage(strings.badToken);
  $('[data-business]').textContent = view.businessName ?? strings.heading;
  const frame = $<HTMLIFrameElement>('.device iframe');
  if (frame.src !== view.draftUrl) frame.src = view.draftUrl;
  $<HTMLAnchorElement>('[data-draft-link]').href = view.previewUrl ?? view.draftUrl;
  $<HTMLButtonElement>('[data-undo]').disabled = !view.canUndo;
  for (const field of CONTACT_FIELDS) {
    const input = contactForm.elements.namedItem(field) as HTMLInputElement;
    const value = view.contact?.[field] ?? '';
    input.value = value && (field === 'whatsapp' || field === 'phone') ? `+${value}` : value;
  }
  $<HTMLButtonElement>('[data-delete]').onclick = async () => {
    if (window.prompt(`${strings.deleteConfirm} ${view.slug}`) !== view.slug) return;
    const { status } = await api('/me', 'DELETE');
    if (status === 200) showMessage(strings.deleted);
  };
  show('editor');
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

/** Follows an edit job to the end: questions when the model asks, then the new draft. */
async function followEdit(jobId: string) {
  show('working');
  const job = await waitForJob(jobId);
  if (job.status === 'NEEDS_INPUT') {
    renderQuestions($<HTMLElement>('[data-question-list]'), job.questions ?? [], strings.question);
    const answer = async (body: Parameters<typeof sendAnswers>[1]) => {
      const { status, body: result } = await sendAnswers(jobId, body);
      if (status === 400) return markInvalid($<HTMLElement>('[data-question-list]'), result.fields ?? [], strings.question.invalid);
      if (status === 202 || status === 409) return void followEdit(jobId);
      await load();
      notice(status === 422 ? strings.rejected : strings.error, 'error');
    };
    questionsForm.onsubmit = (event) => {
      event.preventDefault();
      void answer({ answers: readAnswers($<HTMLElement>('[data-question-list]')) });
    };
    $<HTMLButtonElement>('[data-skip]').onclick = () => void answer({ skip: true });
    show('questions');
    return;
  }
  await load();
  if (job.status === 'DONE') {
    editForm.reset();
    notice(strings.changed);
  } else notice(job.status === 'REJECTED' ? strings.rejected : strings.error, 'error');
}

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = (editForm.elements.namedItem('instruction') as HTMLTextAreaElement).value.trim();
  if (instruction.length < 3) return notice(strings.empty, 'error');
  const button = editForm.querySelector('button[type="submit"]') as HTMLButtonElement;
  button.disabled = true;
  try {
    const { status, body } = await api<{ jobId?: string }>('/me/edit', 'POST', { instruction });
    if (status === 202 && body.jobId) return void followEdit(body.jobId);
    notice(status === 429 ? strings.limit : strings.error, 'error');
  } catch {
    notice(strings.error, 'error');
  } finally {
    button.disabled = false;
  }
});

contactForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(contactForm)) as Record<string, string>;
  const contact = Object.fromEntries(CONTACT_FIELDS.map((field) => [field, (data[field] ?? '').trim()]));
  const button = contactForm.querySelector('button[type="submit"]') as HTMLButtonElement;
  button.disabled = true;
  contactForm.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  try {
    const { status, body } = await api<View & { fields?: string[] }>('/me/edit', 'POST', { contact });
    if (status === 200) {
      fill(body);
      notice(strings.contactSaved);
    } else if (status === 400) {
      for (const field of body.fields ?? []) (contactForm.elements.namedItem(field.split('.').pop() ?? '') as HTMLElement | null)?.setAttribute('aria-invalid', 'true');
      contactForm.querySelector<HTMLElement>('[aria-invalid]')?.focus();
      notice(strings.invalid, 'error');
    } else {
      notice(status === 422 ? strings.rejected : strings.error, 'error');
    }
  } catch {
    notice(strings.error, 'error');
  } finally {
    button.disabled = false;
  }
});

$<HTMLButtonElement>('[data-undo]').onclick = async () => {
  const { status, body } = await api<View>('/me/undo', 'POST');
  if (status === 200) {
    fill(body);
    notice(strings.undone);
  } else notice(strings.error, 'error');
};

root.querySelectorAll<HTMLButtonElement>('.viewport button').forEach((button) => {
  button.onclick = () => {
    root.querySelectorAll<HTMLButtonElement>('.viewport button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    $<HTMLElement>('.device').dataset.width = button.dataset.width;
  };
});

void load();

export {};
