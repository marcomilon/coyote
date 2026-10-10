// The full-screen draft: the owner's token comes from owner-token.ts, like Mi sitio. Reloading shows the
// latest version.
import { api } from './jobs';
import { ownerToken } from './owner-token';

type Message = { title: string; text: string };
interface Strings {
  noToken: Message;
  badToken: Message;
  limited: Message;
}

const root = document.getElementById('preview') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as Strings;
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const token = ownerToken();

function showMessage(message: Message) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  root.dataset.state = 'message';
}

async function load() {
  if (!token) return showMessage(strings.noToken);
  const { status, body } = await api<{ draftUrl?: string; previewUrl?: string }>('/me', { headers: { authorization: `Bearer ${token}` } });
  if (status === 429) return showMessage(strings.limited);
  const url = status === 200 ? (body.previewUrl ?? body.draftUrl) : undefined;
  if (!url) return showMessage(strings.badToken);
  $<HTMLIFrameElement>('[data-frame]').src = url;
  root.dataset.state = 'ready';
}

void load().catch(() => showMessage(strings.badToken));
