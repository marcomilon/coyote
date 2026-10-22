import { t, type Lang } from '../i18n/strings';
import { COUNTRIES } from './landing';
import { LOCAL_PRICES, priceValue, type PriceKind } from '../../../services/generator/src/core/prices';

/**
 * What we sell, as schema.org Offers for the home page's JSON-LD (search engines and AI answers read prices there).
 * Each paid offer comes once per country with a local price, plus once in USD for every other country on the picker.
 */
export function offers(lang: Lang, vos: boolean, url: string) {
  const p = t(lang, vos).home.pricing;
  const local = Object.keys(LOCAL_PRICES);
  const rest = COUNTRIES.map((c) => c.code).filter((code) => !local.includes(code));
  const regions = (codes: string[]) => codes.map((code) => ({ '@type': 'Country', name: code }));
  const paid = (kind: PriceKind, name: string, monthly: boolean) =>
    [...local.map((code) => ({ country: code, codes: [code] })), { country: '', codes: rest }].map(({ country, codes }) => {
      const { currency, value } = priceValue(kind, country);
      const price = { price: value, priceCurrency: currency };
      return {
        '@type': 'Offer',
        name,
        url,
        ...price,
        ...(monthly && { priceSpecification: { '@type': 'UnitPriceSpecification', ...price, billingDuration: 'P1M' } }),
        eligibleRegion: regions(codes),
      };
    });
  return [
    { '@type': 'Offer', name: p.free.name, description: p.free.text[0], url, price: 0, priceCurrency: 'USD' },
    ...paid('plan', p.pro.name, true),
    ...paid('designs', p.designs.name, false),
  ];
}
