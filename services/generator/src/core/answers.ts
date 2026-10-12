import { z } from 'zod';
import { Contact } from './content';

export const Lang = z.enum(['es', 'pt']);

/** The form's "¿Qué quieres que hagan tus clientes?": what the owner most wants a visitor to do. */
export const PAGE_GOALS = ['info', 'whatsapp', 'call', 'visit', 'book'] as const;
export const Goal = z.enum(PAGE_GOALS);
export type PageGoal = z.infer<typeof Goal>;
export type Lang = z.infer<typeof Lang>;

/** The 3 form questions plus the language selector, after normalization. */
export const Answers = z.object({
  businessName: z.string().trim().min(2).max(80),
  /** At least a short sentence: 10 characters and 3 words. */
  about: z
    .string()
    .trim()
    .min(10)
    .max(1000)
    .refine((text) => text.split(/\s+/).length >= 3),
  contact: Contact,
  lang: Lang,
  /** The form's "Fotos creadas con IA" toggle: the page writer may make photos. Missing: no. */
  aiImages: z.boolean().optional(),
  goal: Goal.optional(),
  /** The form's photo descriptions: entry i is upload photo-(i+1). Empty entries are "". Kept with the site's images (Media.captions). */
  photoNotes: z.array(z.string().trim().max(100)).max(6).optional(),
});
export type Answers = z.infer<typeof Answers>;

export interface RawAnswers {
  businessName: string;
  about: string;
  whatsapp: string;
  email?: string;
  address?: string;
  instagram?: string;
  facebook?: string;
  lang?: string;
  aiImages?: boolean;
  goal?: string;
  photoNotes?: string[];
}

const handle = (value: string | undefined, host: string): string | undefined => {
  if (!value) return undefined;
  const cleaned = value
    .trim()
    // With or without the scheme: owners type "facebook.com/name" (the form's own example), "m.facebook.com/name"…
    .replace(new RegExp(`^(https?://)?(www\\.|m\\.)?${host}(/|$)`, 'i'), '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return cleaned || undefined;
};

const digits = (value: string) => value.replace(/\D/g, '').replace(/^00/, '');

export type ContactField = keyof Contact;

/** Cleans one raw contact value the way the form does. Empty → undefined. Validate the result with `Contact`. */
export function cleanContact(field: ContactField, value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  switch (field) {
    case 'whatsapp':
    case 'phone':
      return digits(trimmed) || undefined;
    case 'instagram':
      return handle(trimmed, 'instagram\\.com');
    case 'facebook':
      return handle(trimmed, 'facebook\\.com');
    case 'email':
      return trimmed.toLowerCase();
    case 'address':
      return trimmed;
  }
}

/** Cleans raw form input, then validates. Throws ZodError on invalid input. */
export function normalizeAnswers(raw: RawAnswers): Answers {
  return Answers.parse({
    businessName: raw.businessName,
    about: raw.about,
    lang: raw.lang ?? 'es',
    ...(raw.aiImages !== undefined && { aiImages: raw.aiImages === true }),
    ...(raw.goal && { goal: raw.goal }),
    ...(raw.photoNotes?.some((note) => note.trim()) && { photoNotes: raw.photoNotes }),
    contact: {
      whatsapp: cleanContact('whatsapp', raw.whatsapp) ?? '',
      email: cleanContact('email', raw.email),
      address: cleanContact('address', raw.address),
      instagram: cleanContact('instagram', raw.instagram),
      facebook: cleanContact('facebook', raw.facebook),
    },
  });
}
