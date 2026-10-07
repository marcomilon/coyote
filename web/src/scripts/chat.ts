// The chat page: the owner opens it on their phone from the QR code next to their site (chat-thread.ts does the chat).
import { startChat, type ChatStrings } from './chat-thread';
import { ownerHash, ownerToken } from './owner-token';

const root = document.getElementById('chat') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as ChatStrings & { previewPath: string };
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const token = ownerToken();

startChat($('[data-chat]'), {
  token,
  strings,
  scroll: 'page',
  onView(view) {
    if (view.businessName) $('[data-business]').textContent = view.businessName;
    // Drafts open only inside the app (cf-rewrite.js), so "Ver sitio" goes to the full-screen page.
    if (view.previewUrl ?? view.draftUrl) $<HTMLAnchorElement>('[data-draft-link]').href = `${strings.previewPath}${ownerHash()}`;
    root.dataset.state = 'chat';
  },
  onNote(note) {
    $('[data-message-title]').textContent = note.title;
    $('[data-message-text]').textContent = note.text;
    root.dataset.state = 'message';
  },
});
