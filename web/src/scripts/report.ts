// Generated sites have no JavaScript and no forms, so their "Reportar" link points here: /reportar?sitio=<slug>.
type Message = { title: string; text: string };

const root = document.getElementById('report') as HTMLElement;
const strings = JSON.parse(root.dataset.strings ?? '{}') as { sent: Message; missing: Message; error: string };
const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
const apiUrl = (window.COYOTE_CONFIG?.apiUrl ?? '').replace(/\/+$/, '');
const slug = new URLSearchParams(location.search).get('sitio') ?? '';

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
  button.disabled = true;
  try {
    const response = await fetch(`${apiUrl}/report/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: $<HTMLTextAreaElement>('#reason').value }),
    });
    // A site that is already gone is still a finished report from the visitor's point of view.
    if (response.status === 202 || response.status === 404) return showMessage(strings.sent);
    $('[data-notice]').textContent = strings.error;
  } catch {
    $('[data-notice]').textContent = strings.error;
  } finally {
    button.disabled = false;
  }
});

export {};
