// What Paddle charges for the monthly plan and a design pack, by country. Shown on the home page and in Mi sitio.
// The base price is USD; the countries below have a round local price, which must match the `unit_price_overrides` of
// the two Paddle prices (PLAN-PAYMENTS.md). Paddle picks the override from the buyer's country (IP, or the one entered
// at checkout); every other country pays the USD price. Amounts include tax.

export type PriceKind = 'plan' | 'designs';
export type Currency = 'USD' | 'MXN' | 'BRL' | 'ARS' | 'CLP' | 'COP' | 'PEN';

/** In the currency's lowest unit, as Paddle takes it (cents; CLP has none). */
export interface CountryPrices {
  currency: Currency;
  plan: number;
  designs: number;
}

export const BASE: CountryPrices = { currency: 'USD', plan: 999, designs: 499 };

export const LOCAL_PRICES: Record<string, CountryPrices> = {
  AR: { currency: 'ARS', plan: 1_499_900, designs: 749_900 },
  BR: { currency: 'BRL', plan: 4990, designs: 2490 },
  CL: { currency: 'CLP', plan: 9990, designs: 4990 },
  CO: { currency: 'COP', plan: 3_190_000, designs: 1_590_000 },
  MX: { currency: 'MXN', plan: 17_900, designs: 8900 },
  PE: { currency: 'PEN', plan: 3490, designs: 1690 },
};

/** Paddle's decimals per currency (GET /currencies): COP has 2 there, though nobody writes them. */
export const DECIMALS: Record<Currency, number> = { USD: 2, MXN: 2, BRL: 2, ARS: 2, CLP: 0, COP: 2, PEN: 2 };

/** "Precios en {currency}" on the home page. */
export const CURRENCY_NAMES: Record<Currency, { es: string; pt: string }> = {
  USD: { es: 'dólares (USD)', pt: 'dólares (USD)' },
  MXN: { es: 'pesos mexicanos (MXN)', pt: 'pesos mexicanos (MXN)' },
  BRL: { es: 'reales (BRL)', pt: 'reais (R$)' },
  ARS: { es: 'pesos argentinos (ARS)', pt: 'pesos argentinos (ARS)' },
  CLP: { es: 'pesos chilenos (CLP)', pt: 'pesos chilenos (CLP)' },
  COP: { es: 'pesos colombianos (COP)', pt: 'pesos colombianos (COP)' },
  PEN: { es: 'soles (PEN)', pt: 'soles (PEN)' },
};

export const pricesFor = (country: string): CountryPrices => LOCAL_PRICES[country] ?? BASE;

/**
 * "$179", "R$ 49,90", "US$ 9,99": the way the country writes it (an unknown country: Latin American Spanish or
 * Brazilian Portuguese). Whole amounts lose their ",00".
 */
export function formatPrice(kind: PriceKind, country: string, lang: 'es' | 'pt'): string {
  const { currency, [kind]: amount } = pricesFor(country);
  const value = amount / 10 ** DECIMALS[currency];
  const locale = country === 'BR' || (!country && lang === 'pt') ? 'pt-BR' : country ? `es-${country}` : 'es-419';
  const digits = Number.isInteger(value) ? 0 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
