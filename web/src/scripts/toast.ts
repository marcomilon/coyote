// Mi sitio's page messages ("Tu página web se actualizó."): a toast at the bottom of the screen that goes by itself,
// or on a click. The element stays in the page (global.css hides it) so screen readers still hear each message.
const SHOW_MS = 5000;

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(element: HTMLElement, text: string) {
  clearTimeout(timer);
  element.onclick = () => element.removeAttribute('data-show');
  element.textContent = text;
  element.toggleAttribute('data-show', Boolean(text));
  if (text) timer = setTimeout(() => element.removeAttribute('data-show'), SHOW_MS);
}
