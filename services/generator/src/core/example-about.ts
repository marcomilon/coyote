/**
 * The example descriptions we show owners: the form's placeholder and the "describe your business again" message.
 * strings.ts reads them from here. Copied back as a description, they describe no real business: the owner is sent
 * back to the form before any model call.
 */
export const EXAMPLE_ABOUT = {
  es: {
    placeholder: 'Panadería de barrio en Chapinero, Bogotá. Pan de masa madre, croissants y café. Abrimos de lunes a sábado de 7 a 19…',
    unclear: 'Panadería en Cusco: pan de masa madre y tortas por encargo',
  },
  vos: {
    placeholder: 'Panadería de barrio en Palermo, Buenos Aires. Pan de masa madre, medialunas y café. Abrimos de lunes a sábado de 7 a 19…',
    unclear: 'Panadería en Rosario: pan de masa madre y tortas por encargo',
  },
  pt: {
    placeholder: 'Padaria de bairro em Pinheiros, São Paulo. Pão de fermentação natural, croissants e café. Abrimos de segunda a sábado das 7 às 19…',
    unclear: 'Padaria em Recife: pão de fermentação natural e bolos por encomenda',
  },
};

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const EXAMPLES = Object.values(EXAMPLE_ABOUT).flatMap((e) => [words(e.placeholder), words(e.unclear)]);

/** One of our examples, give or take punctuation, accents, case, and a couple of words around it. */
export function isOurExample(text: string): boolean {
  const own = words(text);
  return EXAMPLES.some((example) => own.includes(example) && own.replace(example, ' ').trim().split(/\s+/).filter(Boolean).length < 3);
}
