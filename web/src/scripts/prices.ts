// Prices in Mi sitio and the chat, in the currency Paddle's checkout will charge: Paddle picks it from the buyer's
// country by IP, and so do we (phone.ts detectCountry). Until that answer, the USD price.
import { formatPrice, type PriceKind } from '../../../services/generator/src/core/prices';
import { detectCountry } from './phone';

let country = '';
const lang = () => (document.documentElement.lang.startsWith('pt') ? 'pt' : 'es');

/** "Comprar 3 diseños · {price}" → the price as the visitor's country pays it. */
export const withPrice = (text: string, kind: PriceKind) => text.replace('{price}', formatPrice(kind, country, lang()));

/** Every `[data-price="plan|designs"]` on the page shows that price; again once the country is known. */
function fill() {
  document.querySelectorAll<HTMLElement>('[data-price]').forEach((el) => {
    el.textContent = formatPrice(el.dataset.price as PriceKind, country, lang());
  });
}

void detectCountry().then((code) => {
  country = code;
  fill();
});
