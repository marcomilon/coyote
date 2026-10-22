import type { Lang } from '../i18n/strings';
import { COUNTRIES as PHONE_COUNTRIES } from '../../../services/generator/src/core/phones';

/**
 * Business facts on the home page: countries, stats, testimonials, the WhatsApp number.
 * Every value wrapped in TODO() is a placeholder from the design handoff that the business must replace
 * (grep for "TODO(" to find them all). Values that are null are left off the page until they're set.
 */
const TODO = <T>(placeholder: T): T => placeholder;

export interface CountryInfo {
  code: string;
  flag: string;
  name: Record<Lang, string>;
}

const flag = (iso: string) => String.fromCodePoint(...[...iso].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));

/**
 * The country picker in the header: the same countries as the form's phone field (core/phones.ts).
 * Changes the prices (core/prices.ts: local currency where Paddle has one for the country, else USD).
 */
export const COUNTRIES: CountryInfo[] = PHONE_COUNTRIES.map((c) => ({ code: c.iso, flag: flag(c.iso), name: c.name }));

/** In the picker's order: alphabetical in the page's language, like the form. */
export const countriesFor = (lang: Lang) => [...COUNTRIES].sort((a, b) => a.name[lang].localeCompare(b.name[lang], lang));

/** Rendered on the server; the picker then switches to the visitor's saved or guessed country. */
export const DEFAULT_COUNTRY: Record<Lang, string> = { es: 'MX', pt: 'BR' };

/** Numbers next to "Negocios como el tuyo" (real ones only); empty hides them. */
export const STATS: { value: string; label: Record<Lang, string> }[] = [];

export interface Testimonial {
  quote: string;
  name: string;
  /** "Negocio · Ciudad, país" */
  business: string;
  /** ISO code of the customer's country; its flag (web/public/flags/<code>.svg) fills the avatar circle when there is no photo. */
  country: string;
  /** 4:3 screenshot of the customer's real site, in web/public; null shows a striped placeholder. */
  screenshot: string | null;
  /** Square photo in web/public; null shows a striped placeholder. */
  avatar: string | null;
  /** The example site the screenshot links to (EXAMPLE_SITES in services/generator/src/core/examples.ts); null: no link. */
  site: string | null;
}

/** Real quotes, with the customer's permission. Each language lists its own customers. */
export const TESTIMONIALS: Record<Lang, Testimonial[]> = TODO({
  es: [
    { quote: 'Subimos el logo y las fotos de los modelos, y en minutos teníamos la página del proyecto para enviar por WhatsApp.', name: 'Carmen Salazar', business: 'Residencial Oliva · Lima, PE', country: 'PE', screenshot: '/ejemplos/residencial-oliva.jpg', avatar: null, site: 'residencial-oliva' },
    { quote: 'Ahora la gente me agenda por WhatsApp desde Google. Antes solo llegaban los del barrio.', name: 'Jorge Ruiz', business: 'Taller Ruiz · Guadalajara, MX', country: 'MX', screenshot: '/ejemplos/taller-ruiz.jpg', avatar: null, site: 'taller-ruiz' },
    { quote: 'Lo hice en la tarde, mientras horneaba. Mis clientas ya ven el menú del día.', name: 'Rosa Gómez', business: 'Panadería Rosa · Medellín, CO', country: 'CO', screenshot: '/ejemplos/panaderia-rosa.jpg', avatar: null, site: 'panaderia-rosa' },
    { quote: 'No sabía nada de páginas. Pedí los cambios como si le escribiera a una amiga.', name: 'Lucía Pérez', business: 'Salón Luna · Buenos Aires, AR', country: 'AR', screenshot: '/ejemplos/salon-luna.jpg', avatar: null, site: 'salon-luna' },
  ],
  pt: [
    { quote: 'Enviamos o logo e as fotos dos modelos, e em minutos tínhamos o site do empreendimento para mandar pelo WhatsApp.', name: 'Carmen Salazar', business: 'Residencial Oliva · Lima, PE', country: 'PE', screenshot: '/ejemplos/residencial-oliva.jpg', avatar: null, site: 'residencial-oliva' },
    { quote: 'Agora o pessoal marca horário pelo WhatsApp direto do Google. Antes só vinha gente do bairro.', name: 'Jorge Ruiz', business: 'Oficina Ruiz · Curitiba, BR', country: 'BR', screenshot: '/ejemplos/taller-ruiz.jpg', avatar: null, site: 'taller-ruiz' },
    { quote: 'Fiz à tarde, enquanto assava o pão. Minhas clientes já veem o cardápio do dia.', name: 'Rosa Gomes', business: 'Padaria Rosa · Belo Horizonte, BR', country: 'BR', screenshot: '/ejemplos/panaderia-rosa.jpg', avatar: null, site: 'panaderia-rosa' },
    { quote: 'Eu não sabia nada de sites. Pedi as mudanças como se escrevesse para uma amiga.', name: 'Lúcia Pereira', business: 'Studio Lua · Porto Alegre, BR', country: 'BR', screenshot: '/ejemplos/salon-luna.jpg', avatar: null, site: 'salon-luna' },
  ],
});

/** Photos for the hero phone examples (Taller, Panadería, Salón, Inmobiliaria), in web/public; null shows a striped slot.
 * The hero photo of each example site (examples/sites/<slug>/assets), resized to 640px. */
export const EXAMPLE_PHOTOS: (string | null)[] = ['/ejemplos/phone-taller-ruiz.jpg', '/ejemplos/phone-panaderia-rosa.jpg', '/ejemplos/phone-salon-luna.jpg', '/ejemplos/phone-residencial-oliva.jpg'];

/** Our own social pages: on Sobre nosotros and in the Organization's JSON-LD (sameAs). */
export const SOCIAL = {
  facebook: 'https://www.facebook.com/ventas314com/',
  instagram: { handle: '@ventas314com', url: 'https://www.instagram.com/ventas314com/' },
};

export const WHATSAPP = {
  /** Support number, digits with country code (e.g. '5215500000000'). null hides every WhatsApp contact link. */
  number: TODO(null as string | null),
  /** Shown in the footer, e.g. '+52 55 0000 0000'. */
  display: TODO(null as string | null),
  /** True once owners can create a site by chatting on WhatsApp. Until then "Créalo por WhatsApp" opens the web form. */
  onboarding: false,
  /** Prefilled first message. */
  message: { es: 'Hola, quiero crear la página web de mi negocio.', pt: 'Olá, quero criar o site do meu negócio.' } as Record<Lang, string>,
};

/** Hero CTA order: WhatsApp first ("Créalo por WhatsApp" / "Crear en la web") instead of the web form first. */
export const WHATSAPP_FIRST = false;

/** "Gratis para empezar · Sin tarjeta · Cancela cuando quieras" under the hero buttons. */
export const SHOW_HERO_TERMS = TODO(true);

/** wa.me link with the prefilled message, or null without a number. */
export const whatsappLink = (lang: Lang) =>
  WHATSAPP.number ? `https://wa.me/${WHATSAPP.number}?text=${encodeURIComponent(WHATSAPP.message[lang])}` : null;
