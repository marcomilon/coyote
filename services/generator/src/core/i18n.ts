import type { Lang } from './answers';
import { countryOf } from './phones';

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
