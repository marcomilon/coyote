import type { Lang } from './answers';

const STRINGS = {
  es: {
    htmlLang: 'es',
    services: 'Servicios',
    about: 'Nosotros',
    visit: 'Dónde estamos',
    hours: 'Horario',
    map: 'Ver en el mapa',
    contact: 'Contacto',
    whatsappGreeting: 'Hola, vi su sitio web y quiero más información.',
    madeWith: 'Sitio creado con Coyote',
    report: 'Reportar',
    privacy: 'Privacidad',
  },
  pt: {
    htmlLang: 'pt-BR',
    services: 'Serviços',
    about: 'Sobre nós',
    visit: 'Onde estamos',
    hours: 'Horário',
    map: 'Ver no mapa',
    contact: 'Contato',
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
