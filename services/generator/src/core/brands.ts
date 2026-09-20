/**
 * Names nobody may impersonate. Shared by the slug check and the content policy.
 * `whole` entries are short or common words and match a whole word only; `anywhere` entries match
 * inside the text with spaces and punctuation removed ("Banco Azteca" → "bancoazteca").
 */
interface BrandList {
  whole: string[];
  anywhere: string[];
}

/** Banks, payment companies, couriers: the usual phishing targets. Checked in names and in headlines. */
const FINANCIAL: BrandList = {
  whole: ['bbva', 'itau', 'dhl', 'ups'],
  anywhere: [
    'bancolombia', 'davivienda', 'banamex', 'banorte', 'bancoazteca', 'santander', 'scotiabank', 'bradesco',
    'nubank', 'bancodobrasil', 'bancoestado', 'mercadopago', 'paypal', 'mastercard', 'correios', 'fedex',
  ],
};

/**
 * Government agencies and big platforms. Checked in names only: an accountant may write "declaraciones
 * ante el SAT" and any business may write "pide por WhatsApp", but neither may be called that.
 */
const NAME_ONLY: BrandList = {
  whole: ['sat', 'afip', 'dian', 'sunat', 'apple'],
  anywhere: [
    'receitafederal', 'mercadolibre', 'mercadolivre', 'rappi', 'whatsapp', 'facebook', 'instagram', 'google',
    'netflix', 'amazon',
  ],
};

/** Lowercase, no diacritics, non-alphanumerics become spaces. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Returns the impersonated brand, or null.
 * scope "name": business name and slug. scope "copy": title and headline.
 */
export function findBrand(value: string, scope: 'name' | 'copy'): string | null {
  const normalized = normalizeForMatch(value);
  const words = new Set(normalized.split(' '));
  const compact = normalized.replace(/ /g, '');
  const lists = scope === 'name' ? [FINANCIAL, NAME_ONLY] : [FINANCIAL];
  for (const list of lists) {
    const hit = list.whole.find((b) => words.has(b)) ?? list.anywhere.find((b) => compact.includes(b));
    if (hit) return hit;
  }
  return null;
}
