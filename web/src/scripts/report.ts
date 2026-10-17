// Generated sites have no JavaScript and no forms, so their "Reportar" link points here: /reportar?sitio=<slug>.
import { humanCheck } from './turnstile';
import { setBusy } from './busy';

type Message = { title: string; text: string };

const root = document.getElementById('report') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as { lang: string; sent: Message; missing: Message; error: string; limited: string; captcha: string };
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const apiUrl = (window.COYOTE_CONFIG?.apiUrl ?? '').replace(/\/+$/, '');
const slug = new URLSearchParams(location.search).get('sitio') ?? '';
const human = humanCheck($<HTMLElement>('[data-human-check]'), strings.lang);

function showMessage(message: Message) {
  $('[data-message-title]').textContent = message.title;
  $('[data-message-text]').textContent = message.text;
  root.dataset.state = 'message';
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) showMessage(strings.missing);
else $('[data-slug]').textContent = slug;

$<HTMLFormElement>('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>('button[type="submit"]');
  setBusy(button, true);
  try {
    const response = await fetch(`${apiUrl}/report/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: $<HTMLTextAreaElement>('#reason').value, turnstileToken: await human.token() }),
    });
    human.reset();
    // A site that is already gone is still a finished report from the visitor's point of view.
    if (response.status === 202 || response.status === 404) return showMessage(strings.sent);
    $('[data-notice]').textContent = response.status === 429 ? strings.limited : response.status === 403 ? strings.captcha : strings.error;
  } catch {
    human.reset();
    $('[data-notice]').textContent = strings.error;
  } finally {
    setBusy(button, false);
  }
});

export {};
