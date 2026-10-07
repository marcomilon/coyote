// WhatsApp numbers for the countries the form lists. Shared by the form (country picker) and the API
// (validation), so a number the form accepts is exactly one the API accepts.

export interface Country {
  iso: string;
  dial: string;
  name: { es: string; pt: string };
  /** A local mobile number, shown as the placeholder. */
  example: string;
  /** Digits in a local WhatsApp number (without the country code), shortest and longest. */
  digits: [number, number];
}

// Spanish-speaking Latin America plus Brazil (except Venezuela and Cuba), and the United States.
export const COUNTRIES: Country[] = [
  { iso: 'AR', dial: '54', name: { es: 'Argentina', pt: 'Argentina' }, example: '9 11 2345 6789', digits: [11, 11] },
  { iso: 'BO', dial: '591', name: { es: 'Bolivia', pt: 'Bolívia' }, example: '7123 4567', digits: [8, 8] },
  { iso: 'BR', dial: '55', name: { es: 'Brasil', pt: 'Brasil' }, example: '11 91234 5678', digits: [10, 11] },
  { iso: 'CL', dial: '56', name: { es: 'Chile', pt: 'Chile' }, example: '9 1234 5678', digits: [9, 9] },
  { iso: 'CO', dial: '57', name: { es: 'Colombia', pt: 'Colômbia' }, example: '300 123 4567', digits: [10, 10] },
  { iso: 'CR', dial: '506', name: { es: 'Costa Rica', pt: 'Costa Rica' }, example: '8312 3456', digits: [8, 8] },
  { iso: 'EC', dial: '593', name: { es: 'Ecuador', pt: 'Equador' }, example: '99 123 4567', digits: [9, 9] },
  { iso: 'SV', dial: '503', name: { es: 'El Salvador', pt: 'El Salvador' }, example: '7012 3456', digits: [8, 8] },
  { iso: 'GT', dial: '502', name: { es: 'Guatemala', pt: 'Guatemala' }, example: '5123 4567', digits: [8, 8] },
  { iso: 'HN', dial: '504', name: { es: 'Honduras', pt: 'Honduras' }, example: '9123 4567', digits: [8, 8] },
  { iso: 'MX', dial: '52', name: { es: 'México', pt: 'México' }, example: '55 1234 5678', digits: [10, 10] },
  { iso: 'NI', dial: '505', name: { es: 'Nicaragua', pt: 'Nicarágua' }, example: '8123 4567', digits: [8, 8] },
  { iso: 'PA', dial: '507', name: { es: 'Panamá', pt: 'Panamá' }, example: '6123 4567', digits: [8, 8] },
  { iso: 'PY', dial: '595', name: { es: 'Paraguay', pt: 'Paraguai' }, example: '961 456789', digits: [9, 9] },
  { iso: 'PE', dial: '51', name: { es: 'Perú', pt: 'Peru' }, example: '912 345 678', digits: [9, 9] },
  { iso: 'PR', dial: '1', name: { es: 'Puerto Rico', pt: 'Porto Rico' }, example: '787 234 5678', digits: [10, 10] },
  { iso: 'DO', dial: '1', name: { es: 'República Dominicana', pt: 'República Dominicana' }, example: '809 234 5678', digits: [10, 10] },
  { iso: 'US', dial: '1', name: { es: 'Estados Unidos', pt: 'Estados Unidos' }, example: '305 123 4567', digits: [10, 10] },
  { iso: 'UY', dial: '598', name: { es: 'Uruguay', pt: 'Uruguai' }, example: '94 231 234', digits: [8, 8] },
];

/** The listed country a full number ("<code><number>", digits only) belongs to: the longest matching code. */
export function countryOf(number: string): Country | undefined {
  for (const length of [3, 2, 1]) {
    const match = COUNTRIES.find((c) => c.dial.length === length && number.startsWith(c.dial));
    if (match) return match;
  }
  return undefined;
}

/** True unless the number is for a listed country and has the wrong number of digits for it. */
export function validForCountry(number: string): boolean {
  const country = countryOf(number);
  if (!country) return true;
  const local = number.length - country.dial.length;
  return local >= country.digits[0] && local <= country.digits[1];
}
