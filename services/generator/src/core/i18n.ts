import type { Lang } from './answers';

/** The platform footer page-check.ts adds to every page. */
const STRINGS = {
  es: {
    madeWith: 'Sitio creado con ventas314.com',
    report: 'Reportar',
    privacy: 'Privacidad',
  },
  pt: {
    madeWith: 'Site criado com ventas314.com',
    report: 'Denunciar',
    privacy: 'Privacidade',
  },
} as const;

export type Strings = (typeof STRINGS)[Lang];

export function strings(lang: Lang): Strings {
  return STRINGS[lang];
}
