import type { Lang } from './answers';
import { countryOf } from './phones';

/** The platform footer page-check.ts adds to every page. */
const STRINGS = {
  es: {
    madeWith: 'Página web creada con ventas314.com',
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

/**
 * Countries whose Spanish uses vos instead of tú. The app shows them its vos pages (CloudFront picks them by the
 * visitor's country) and the vos versions of the chat replies, chat notes and emails (by the site's phone country).
 */
export const VOSEO_COUNTRIES = ['AR', 'UY', 'PY'] as const;

export function usesVoseo(country: string | undefined): boolean {
  return !!country && (VOSEO_COUNTRIES as readonly string[]).includes(country);
}

/** The app's texts for one site: Portuguese, Spanish with tú, or Spanish with vos (by the site's phone country). */
export type Voice = Lang | 'vos';

export function voiceOf(answers: { lang: Lang; contact: { whatsapp: string } }): Voice {
  return answers.lang === 'es' && usesVoseo(countryOf(answers.contact.whatsapp.replace(/\D/g, ''))?.iso) ? 'vos' : answers.lang;
}
