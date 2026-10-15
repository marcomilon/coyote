// The chat with the site: each message is a change request; the reply arrives a few seconds later (polled from
// GET /me/chat). A change too big for the chat comes with a "Rediseñar" button that starts the usual page-writer
// edit (POST /me/edit), followed here. Used full-page on the phone (chat.ts) and inside Mi sitio (my-site.ts).
import { api as apiCall, apiUrl, sendAnswers, waitForJob } from './jobs';
import { markInvalid, readAnswers, renderQuestions, type QuestionStrings } from './questions';

interface Message {
  at: number;
  role: 'owner' | 'coyote';
  text: string;
  status: 'pending' | 'done' | 'failed';
  changed?: boolean;
  undone?: boolean;
  redesign?: string;
  /** Its "Rediseñar" button was used: it stays, disabled. */
  redesignStarted?: boolean;
  /** Only in this browser: a request that could not start. */
  local?: boolean;
  /** A redesign's note while it runs: the edit job to follow (its questions, its end). */
  jobId?: string;
  /** A finished redesign: the note links to the full-screen page. */
  redesigned?: boolean;
}
export interface ChatView {
  draftUrl?: string;
  previewUrl?: string;
  canUndo: boolean;
  messages: Message[];
  businessName?: string;
}
type Note = { title: string; text: string };
export interface ChatStrings {
  intro: string;
  thinking: string;
  changed: string;
  undoneTag: string;
  undo: string;
  undoConfirm: string;
  undoYes: string;
  undoNo: string;
  redesign: string;
  openPreview: string;
  rejected: string;
  failed: string;
  busy: string;
  limit: string;
  editLimit: string;
  noDesigns: string;
  error: string;
  noToken: Note;
  badToken: Note;
  limited: Note;
  question: QuestionStrings & { invalid: string };
}

export interface ChatOptions {
  token: string;
  strings: ChatStrings;
  /** 'page': the window scrolls (the phone); 'box': the thread scrolls inside its card (Mi sitio). */
  scroll: 'page' | 'box';
  /** The full-screen page of the current draft (/ver), for "Abrir en otra pestaña". */
  previewLink: () => string;
  /** Each answer from GET /me/chat: the host shows the business name or follows the draft. */
  onView?: (view: ChatView) => void;
  /** The chat can't start: no token or a bad token. */
  onNote: (note: Note, reason: 'noToken' | 'badToken' | 'limited' | 'error') => void;
}

/** Starts the chat in a ChatThread.astro element. */
export function startChat(el: HTMLElement, { token, strings, scroll, previewLink, onView, onNote }: ChatOptions) {
  const $ = <T extends Element>(selector: string) => el.querySelector(selector) as T;
  const thread = $<HTMLOListElement>('[data-thread]');
  const composer = $<HTMLFormElement>('form[data-composer]');
  const input = composer.elements.namedItem('text') as HTMLTextAreaElement;
  const questionsForm = $<HTMLFormElement>('form[data-chat-questions]');

  const messages = new Map<number, Message>();
  let canUndo = false;
  let redesigning = false;
  /** "Deshacer" was tapped: the bubble asks before undoing. */
  let confirmingUndo = false;
  let active = false;
  let pollTimer: number | undefined;
  /** What the thread last showed: a poll that changes nothing leaves the page (and its scroll) alone. */
  let shown = '';

  const show = (state: 'chat' | 'questions') => (el.dataset.state = state);
  const notice = (text: string) => ($('[data-chat-notice]').textContent = text);

  const api = <T>(path: string, method = 'GET', body?: unknown) =>
    apiCall<T>(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const pending = () => [...messages.values()].some((m) => m.status === 'pending');
  const when = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function button(label: string, className: string, onClick: () => void) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className, textContent: label });
    b.onclick = onClick;
    return b;
  }

  const nearBottom = () =>
    scroll === 'box'
      ? thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 80
      : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  const toBottom = () => {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (scroll === 'box') thread.scrollTo({ top: thread.scrollHeight, behavior });
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  };

  /**
   * Messages are the owner's words and model output: text only, never markup. The thread follows a new message
   * only when the owner is already at the bottom (or just sent one); scrolling up to read stays put.
   */
  function render(follow = false) {
    const sorted = [...messages.values()].sort((a, b) => a.at - b.at);
    const state = JSON.stringify([sorted, canUndo, redesigning, confirmingUndo]);
    if (state === shown) return;
    shown = state;
    follow ||= nearBottom();
    const lastChange = sorted.filter((m) => m.changed).at(-1);
    const lastRedesign = sorted.filter((m) => m.redesign).at(-1);
    thread.replaceChildren(
      ...[{ at: 0, role: 'coyote', text: strings.intro, status: 'done' } as Message, ...sorted].map((m) => {
        const li = document.createElement('li');
        li.className = `bubble ${m.role}`;
        li.dataset.status = m.status;
        const p = document.createElement('p');
        p.textContent = m.status === 'pending' && !m.text ? strings.thinking : m.text;
        li.append(p);
        if (m.changed) {
          const tag = Object.assign(document.createElement('span'), { className: m.undone ? 'tag undone' : 'tag', textContent: m.undone ? `↩ ${strings.undoneTag}` : `✓ ${strings.changed}` });
          li.append(tag);
          if (m === lastChange && !m.undone && canUndo && !redesigning) {
            if (!confirmingUndo) li.append(button(strings.undo, 'linkbtn', () => setConfirmingUndo(true)));
            else {
              const ask = Object.assign(document.createElement('div'), { className: 'confirm' });
              const question = Object.assign(document.createElement('p'), { textContent: strings.undoConfirm });
              ask.append(question, button(strings.undoYes, 'btn small', () => void undo()), button(strings.undoNo, 'linkbtn', () => setConfirmingUndo(false)));
              li.append(ask);
            }
          }
        }
        if (m.redesigned) {
          const open = Object.assign(document.createElement('a'), { className: 'linkbtn', href: previewLink(), target: '_blank', rel: 'noopener', textContent: strings.openPreview });
          li.append(open);
        }
        if (m.redesign && m === lastRedesign) {
          const start = button(strings.redesign, 'btn small', () => void redesign(m));
          start.disabled = m.redesignStarted || redesigning || pending();
          li.append(start);
        }
        if (m.at) {
          const time = Object.assign(document.createElement('time'), { dateTime: new Date(m.at).toISOString(), textContent: when.format(m.at) });
          li.append(time);
        }
        return li;
      }),
    );
    composer.querySelector('button')!.disabled = pending() || redesigning;
    $<HTMLElement>('[data-examples]').hidden = sorted.length > 0;
    if (confirmingUndo) $<HTMLElement>('.confirm .btn')?.focus();
    if (follow) toBottom();
  }

  function merge(view: Pick<ChatView, 'messages' | 'canUndo'>, follow = false) {
    for (const m of view.messages) messages.set(m.at, m);
    canUndo = view.canUndo;
    render(follow);
  }

  /** Polls faster while a reply is on its way, and not at all while the screen is off. */
  function schedule() {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(poll, pending() ? 2000 : 6000);
  }

  async function poll() {
    if (!document.hidden) {
      const server = [...messages.values()].filter((m) => !m.local);
      const waiting = server.filter((m) => m.status === 'pending').map((m) => m.at);
      const after = waiting.length > 0 ? Math.min(...waiting) - 1 : Math.max(0, ...server.map((m) => m.at));
      try {
        const { status, body } = await api<ChatView>(`/me/chat?after=${after || 1}`);
        if (status === 200) {
          merge(body);
          onView?.(body);
        }
        if (status === 401) return onNote(strings.badToken, 'badToken');
      } catch {
        // A dropped connection is normal on mobile: the next poll tries again.
      }
    }
    schedule();
  }

  async function send(text: string) {
    if (!text || pending() || redesigning) return;
    notice('');
    composer.querySelector('button')!.disabled = true;
    try {
      const { status, body } = await api<{ messages?: Message[] }>('/me/chat', 'POST', { text });
      if (status === 202 && body.messages) {
        input.value = '';
        merge({ messages: body.messages, canUndo }, true);
        schedule();
        return;
      }
      notice(status === 429 ? strings.limit : status === 409 ? strings.busy : strings.error);
    } catch {
      notice(strings.error);
    }
    render();
  }

  function localNote(text: string, status: Message['status'] = 'done') {
    const note: Message = { at: Date.now(), role: 'coyote', text, status, local: true };
    messages.set(note.at, note);
    render(true);
    return note;
  }

  function setConfirmingUndo(on: boolean) {
    confirmingUndo = on;
    render();
  }

  async function undo() {
    setConfirmingUndo(false);
    const { status, body } = await api<{ canUndo: boolean }>('/me/undo', 'POST');
    if (status !== 200) return notice(strings.error);
    canUndo = body.canUndo;
    const last = [...messages.values()].filter((m) => m.changed && !m.undone).sort((a, b) => a.at - b.at).at(-1);
    if (last) last.undone = true; // as the server now has it
    void poll(); // the server's note, and the host follows the draft
  }

  async function redesign(offer: Message) {
    redesigning = true;
    render();
    try {
      const { status, body } = await api<{ jobId?: string }>('/me/edit', 'POST', { instruction: offer.redesign, from: offer.at });
      if (status === 202 && body.jobId) {
        offer.redesignStarted = true; // as the server now has it
        void poll(); // the server's note about the redesign
        return void (await followRedesign(body.jobId));
      }
      redesigning = false;
      localNote(status === 402 ? strings.noDesigns : status === 429 ? strings.editLimit : status === 422 ? strings.rejected : status === 409 ? strings.busy : strings.failed, 'failed');
    } catch {
      redesigning = false;
      localNote(strings.error, 'failed');
    }
  }

  /** Follows the page writer's edit job: its questions when it asks, then its end (the server's note says how). */
  async function followRedesign(jobId: string) {
    show('chat');
    const job = await waitForJob(jobId);
    if (job.status === 'NEEDS_INPUT') {
      const list = $<HTMLElement>('[data-chat-question-list]');
      renderQuestions(list, job.questions ?? [], strings.question);
      const answer = async (body: Parameters<typeof sendAnswers>[1]) => {
        const { status, body: result } = await sendAnswers(jobId, body);
        if (status === 400) return markInvalid(list, result.fields ?? [], strings.question.invalid);
        if (status === 202 || status === 409) return void followRedesign(jobId);
        finish();
      };
      questionsForm.onsubmit = (event) => {
        event.preventDefault();
        void answer({ answers: readAnswers(list) });
      };
      $<HTMLButtonElement>('[data-chat-skip]').onclick = () => void answer({ skip: true });
      show('questions');
      return;
    }
    finish();

    function finish() {
      redesigning = false;
      show('chat');
      void poll();
    }
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void send(input.value.trim());
  });
  input.addEventListener('keydown', (event) => {
    // Enter sends on a computer; phones keep their return key for new lines.
    if (event.key === 'Enter' && !event.shiftKey && matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  el.querySelectorAll<HTMLButtonElement>('[data-examples] button').forEach((b) => {
    b.onclick = () => {
      input.value = b.textContent ?? '';
      input.focus();
    };
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active) void poll();
  });

  async function load() {
    if (!token || !apiUrl) return onNote(strings.noToken, 'noToken');
    try {
      const { status, body } = await api<ChatView>('/me/chat');
      if (status === 429) return onNote(strings.limited, 'limited');
      if (status !== 200 || !body.draftUrl) return onNote(strings.badToken, 'badToken');
      onView?.(body);
      active = true;
      show('chat');
      merge(body, true);
      schedule();
      // A redesign still running (started before a reload, or on another device): follow it again.
      const running = body.messages.find((m) => m.jobId && m.status === 'pending');
      if (running) {
        redesigning = true;
        render();
        void followRedesign(running.jobId!);
      }
    } catch {
      onNote({ title: strings.error, text: '' }, 'error');
    }
  }

  void load();
}
