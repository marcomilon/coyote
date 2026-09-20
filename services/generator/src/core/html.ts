/** HTML that is already safe to emit. Only `html` and `raw` create it. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

type Interpolation = SafeHtml | string | number | null | undefined | false | Interpolation[];

function toHtml(value: Interpolation): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/** Tagged template: every interpolated value is escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += toHtml(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Trusted markup only: static theme CSS, validated tokens, sanitized signatureCss. Never model or user text. */
export function raw(trusted: string): SafeHtml {
  return new SafeHtml(trusted);
}
