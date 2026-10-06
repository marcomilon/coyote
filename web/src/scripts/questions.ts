// The model's follow-up questions, rendered as a form by our own code. The questions are model output, so
// every text goes in with textContent, never as markup. Used by the create page and by Mi sitio.
import type { Question } from '../../../services/generator/src/core/questions';

export type { Question };
export type AnswerValues = Record<string, string | string[]>;

export interface QuestionStrings {
  yes: string;
  no: string;
  optional: string;
}

const INPUTS: Partial<Record<Question['type'], { type: string; autocomplete?: string; inputmode?: string; placeholder?: string; maxLength: number }>> = {
  text: { type: 'text', maxLength: 500 },
  address: { type: 'text', autocomplete: 'street-address', maxLength: 160 },
  phone: { type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '+', maxLength: 40 },
  whatsapp: { type: 'tel', autocomplete: 'tel', inputmode: 'tel', placeholder: '+', maxLength: 40 },
  email: { type: 'email', autocomplete: 'email', inputmode: 'email', maxLength: 120 },
  instagram: { type: 'text', placeholder: '@', maxLength: 200 },
  facebook: { type: 'text', maxLength: 200 },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

function choices(q: Question, kind: 'radio' | 'checkbox', options: { value: string; label: string }[]): HTMLElement {
  const box = el('div', { className: 'choices' });
  for (const option of options) {
    const label = el('label');
    const input = el('input', { type: kind, name: q.id, value: option.value });
    label.append(input, el('span', {}, option.label));
    box.append(label);
  }
  return box;
}

/** Replaces the container's content with one fieldset per question. */
export function renderQuestions(container: HTMLElement, questions: Question[], strings: QuestionStrings): void {
  container.replaceChildren();
  questions.forEach((q, index) => {
    const fieldset = el('fieldset', { className: 'question' });
    fieldset.dataset.question = q.id;
    const id = `q-${q.id}`;
    const grouped = q.type === 'choice' || q.type === 'multi' || q.type === 'yesno';
    const title = el(grouped ? 'legend' : 'label', { className: 'q' });
    if (!grouped) (title as HTMLLabelElement).htmlFor = id;
    title.append(el('i', {}, String(index + 1)), el('span', {}, q.label));
    fieldset.append(title);
    if (q.help) fieldset.append(el('p', { className: 'hint' }, q.help));

    if (q.type === 'choice' || q.type === 'multi') {
      fieldset.append(choices(q, q.type === 'choice' ? 'radio' : 'checkbox', (q.options ?? []).map((o) => ({ value: o, label: o }))));
    } else if (q.type === 'yesno') {
      fieldset.append(choices(q, 'radio', [{ value: 'yes', label: strings.yes }, { value: 'no', label: strings.no }]));
    } else if (q.type === 'textarea') {
      fieldset.append(el('textarea', { id, name: q.id, maxLength: 500, placeholder: strings.optional }));
    } else {
      const spec = INPUTS[q.type] ?? INPUTS.text!;
      const input = el('input', { id, name: q.id, type: spec.type, maxLength: spec.maxLength, placeholder: spec.placeholder ?? strings.optional });
      if (spec.autocomplete) input.autocomplete = spec.autocomplete as AutoFill;
      if (spec.inputmode) input.inputMode = spec.inputmode;
      if (q.type === 'instagram' || q.type === 'facebook' || q.type === 'email') input.autocapitalize = 'none';
      fieldset.append(input);
    }
    fieldset.append(el('p', { className: 'error', role: 'alert' }));
    container.append(fieldset);
  });
}

/** The non-empty answers, by question id. */
export function readAnswers(container: HTMLElement): AnswerValues {
  const answers: AnswerValues = {};
  for (const fieldset of container.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question]')) {
    const id = fieldset.dataset.question!;
    const inputs = [...fieldset.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
    const checkable = inputs.filter((input): input is HTMLInputElement => input instanceof HTMLInputElement && (input.type === 'radio' || input.type === 'checkbox'));
    if (checkable.length > 0) {
      const picked = checkable.filter((input) => input.checked).map((input) => input.value);
      if (picked.length === 0) continue;
      answers[id] = checkable[0]!.type === 'checkbox' ? picked : picked[0]!;
    } else {
      const value = inputs[0]?.value.trim();
      if (value) answers[id] = value;
    }
  }
  return answers;
}

/** Marks the questions the API refused. */
export function markInvalid(container: HTMLElement, ids: string[], message: string): void {
  for (const fieldset of container.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question]')) {
    const bad = ids.includes(fieldset.dataset.question!);
    fieldset.querySelector('.error')!.textContent = bad ? message : '';
    fieldset.querySelectorAll('input, textarea').forEach((input) => (bad ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid')));
  }
  container.querySelector<HTMLElement>('[aria-invalid]')?.focus();
}
