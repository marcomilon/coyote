import { z } from 'zod';
import { Contact } from './content';

export const Lang = z.enum(['es', 'pt']);
export type Lang = z.infer<typeof Lang>;

/** The 3 form questions plus the language selector, after normalization. */
export const Answers = z.object({
  businessName: z.string().trim().min(2).max(80),
  about: z.string().trim().min(10).max(1000),
  contact: Contact,
  lang: Lang,
});
export type Answers = z.infer<typeof Answers>;

export interface RawAnswers {
  businessName: string;
  about: string;
  whatsapp: string;
  address?: string;
  instagram?: string;
  facebook?: string;
  lang?: string;
}

const handle = (value: string | undefined, host: string): string | undefined => {
  if (!value) return undefined;
  const cleaned = value
    .trim()
    .replace(new RegExp(`^https?://(www\\.)?${host}/`, 'i'), '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return cleaned || undefined;
};

/** Cleans raw form input, then validates. Throws ZodError on invalid input. */
export function normalizeAnswers(raw: RawAnswers): Answers {
  return Answers.parse({
    businessName: raw.businessName,
    about: raw.about,
    lang: raw.lang ?? 'es',
    contact: {
      whatsapp: raw.whatsapp.replace(/\D/g, '').replace(/^00/, ''),
      address: raw.address?.trim() || undefined,
      instagram: handle(raw.instagram, 'instagram\\.com'),
      facebook: handle(raw.facebook, 'facebook\\.com'),
    },
  });
}
