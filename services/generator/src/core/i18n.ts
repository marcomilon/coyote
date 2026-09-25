import type { Lang } from './answers';

/** The few strings our code adds to a generated page. The model writes everything else. */
const STRINGS = {
  es: {
    htmlLang: 'es',
    map: 'Mapa',
    whatsappGreeting: 'Hola, vi su sitio web y quiero más información.',
    madeWith: 'Sitio creado con Coyote',
    report: 'Reportar',
    privacy: 'Privacidad',
  },
  pt: {
    htmlLang: 'pt-BR',
    map: 'Mapa',
    whatsappGreeting: 'Olá, vi o site de vocês e quero mais informações.',
    madeWith: 'Site criado com Coyote',
    report: 'Denunciar',
    privacy: 'Privacidade',
  },
} as const;

export type Strings = (typeof STRINGS)[Lang];

export function strings(lang: Lang): Strings {
  return STRINGS[lang];
}
