// The WhatsApp field on /crear: a country picker plus the local number, joined into one international number.
// The API gets the joined digits and checks them against the same country table (core/phones.ts).
import { COUNTRIES as LIST, type Country } from '../../../services/generator/src/core/phones';

export const countries = (lang: 'es' | 'pt') => [...LIST].sort((a, b) => a.name[lang].localeCompare(b.name[lang], lang));

const flag = (iso: string) => String.fromCodePoint(...[...iso].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
export const countryLabel = (country: Country, lang: 'es' | 'pt') => `${flag(country.iso)} ${country.name[lang]} (+${country.dial})`;

/**
 * Joins the picked country and what the owner typed into "+<code><number>". A number typed with "+" or "00"
 * is already international and is kept as is. Otherwise: drop the trunk "0", drop the country code if they
 * typed it anyway, add the "9" Argentine mobiles need on WhatsApp, and drop Mexico's old mobile "1".
 * Returns '' when the number is the wrong length for the country, so validation flags it.
 */
export function fullNumber(iso: string, typed: string): string {
  const value = typed.trim();
  if (!value || /^(\+|00)/.test(value)) return value;
  const country = LIST.find((c) => c.iso === iso);
  if (!country) return ''; // No country and no "+": we can't tell which number this is.
  let local = value.replace(/\D/g, '').replace(/^0+/, '');
  if (local.length > country.digits[1] && local.startsWith(country.dial)) local = local.slice(country.dial.length).replace(/^0+/, '');
  if (country.iso === 'AR' && local.length === 10) local = `9${local}`;
  if (country.iso === 'MX' && local.length === 11 && local.startsWith('1')) local = local.slice(1);
  if (local.length < country.digits[0] || local.length > country.digits[1]) return '';
  return `+${country.dial}${local}`;
}

// Time zones of the listed countries, for picking the owner's country before they do.
const ZONES: Record<string, string> = {
  La_Paz: 'BO', Santiago: 'CL', Punta_Arenas: 'CL', Bogota: 'CO', Costa_Rica: 'CR', Guayaquil: 'EC', El_Salvador: 'SV',
  Guatemala: 'GT', Tegucigalpa: 'HN', Managua: 'NI', Panama: 'PA', Asuncion: 'PY', Lima: 'PE', Puerto_Rico: 'PR',
  Santo_Domingo: 'DO', Montevideo: 'UY', Galapagos: 'EC', Mexico_City: 'MX', Cancun: 'MX', Merida: 'MX', Monterrey: 'MX', Matamoros: 'MX',
  Chihuahua: 'MX', Ciudad_Juarez: 'MX', Ojinaga: 'MX', Mazatlan: 'MX', Bahia_Banderas: 'MX', Hermosillo: 'MX', Tijuana: 'MX',
  Sao_Paulo: 'BR', Fortaleza: 'BR', Recife: 'BR', Bahia: 'BR', Belem: 'BR', Manaus: 'BR', Cuiaba: 'BR', Campo_Grande: 'BR',
  New_York: 'US', Chicago: 'US', Denver: 'US', Phoenix: 'US', Los_Angeles: 'US', Anchorage: 'US', Honolulu: 'US', Detroit: 'US', Boise: 'US', Indianapolis: 'US',
  Porto_Velho: 'BR', Boa_Vista: 'BR', Rio_Branco: 'BR', Araguaina: 'BR', Maceio: 'BR', Santarem: 'BR', Noronha: 'BR',
};

/** The owner's likely country from the device's time zone, then its language region; '' if neither is listed. */
export function guessCountry(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  if (zone.startsWith('America/Argentina/') || zone === 'America/Buenos_Aires') return 'AR';
  const byZone = ZONES[zone.split('/').pop() ?? ''];
  if (byZone) return byZone;
  for (const tag of navigator.languages ?? []) {
    const region = tag.split('-')[1]?.toUpperCase();
    if (region && LIST.some((c) => c.iso === region)) return region;
  }
  return '';
}

/** Wires the picker: guesses the country when none is chosen and keeps the placeholder in step with it. */
export function setUpCountryPicker(select: HTMLSelectElement, input: HTMLInputElement) {
  if (!select.value) select.value = guessCountry() || select.dataset.fallback || '';
  const sync = () => {
    input.placeholder = LIST.find((c) => c.iso === select.value)?.example ?? '';
  };
  select.addEventListener('change', sync);
  sync();
  // Phone numbers only: digits, spaces, ( ) - and a leading "+".
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/[^\d\s()+-]/g, '').replace(/(?!^)\+/g, '');
    if (cleaned !== input.value) input.value = cleaned;
  });
}
