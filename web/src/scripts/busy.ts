// A button waiting on the server: disabled, with the three loading dots over its label (global.css `[aria-busy]`).
export function setBusy(button: HTMLButtonElement, on: boolean) {
  button.disabled = on;
  if (on) {
    button.setAttribute('aria-busy', 'true');
    if (!button.querySelector('.dots')) button.insertAdjacentHTML('beforeend', '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>');
  } else {
    button.removeAttribute('aria-busy');
    button.querySelector('.dots')?.remove();
  }
}
