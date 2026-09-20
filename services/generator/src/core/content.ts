import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const Service = z.object({
  name: text(60),
  detail: text(160).optional(),
});

export const HoursRow = z.object({
  days: text(40).describe('e.g. "Lunes a viernes"'),
  time: text(40).describe('e.g. "9:00 – 18:00"'),
});

/** What the model writes (the `publish_content` tool input). Copy only, never contact details. */
export const ModelContent = z.object({
  title: text(70).describe('<title>: business name plus what it is and where'),
  description: text(160).describe('Meta description, one sentence'),
  headline: text(80).describe('Hero headline: concrete, max 8 words'),
  subhead: text(160).describe('One sentence under the headline'),
  about: text(600).describe('About paragraph, only facts from the answers'),
  services: z.array(Service).min(1).max(8),
  hours: z.array(HoursRow).max(7).optional().describe('Only if the answers state opening hours'),
  location: z
    .object({
      neighborhood: text(60).optional(),
      city: text(60).optional(),
    })
    .default({})
    .describe('Only what the answers state'),
  ctaText: text(40).describe('WhatsApp button label'),
  signatureCss: z
    .string()
    .max(2000)
    .optional()
    .describe('Optional CSS for the signature element; every selector starts with .signature'),
});
export type ModelContent = z.infer<typeof ModelContent>;

/** Copied verbatim from the form. The model never writes these. */
export const Contact = z.object({
  whatsapp: z.string().regex(/^[1-9]\d{7,14}$/, 'digits only, with country code'),
  address: text(160).optional(),
  instagram: z
    .string()
    .regex(/^[A-Za-z0-9._]{1,30}$/)
    .optional(),
  facebook: z
    .string()
    .regex(/^[A-Za-z0-9.-]{1,50}$/)
    .optional(),
});
export type Contact = z.infer<typeof Contact>;

const assetPath = z.string().regex(/^assets\/[a-z0-9][a-z0-9._-]{0,80}$/);

/** The stored record a page is rendered from. */
export const SiteContent = ModelContent.extend({
  businessName: text(80),
  lang: z.enum(['es', 'pt']),
  contact: Contact,
  media: z
    .object({
      logo: assetPath.optional(),
      photos: z.array(assetPath).max(3),
    })
    .default({ photos: [] }),
});
export type SiteContent = z.infer<typeof SiteContent>;

/** Owner edits ("Mi sitio", WhatsApp Flow B). Applied without a model call. */
export const ContentPatch = ModelContent.pick({
  headline: true,
  subhead: true,
  about: true,
  services: true,
  hours: true,
  ctaText: true,
})
  .partial()
  .extend({
    contact: Contact.partial().optional(),
    removePhotos: z.array(z.number().int().min(0).max(2)).max(3).optional(),
  })
  .strict();
export type ContentPatch = z.infer<typeof ContentPatch>;

/** Returns a new, validated SiteContent. Throws ZodError if the patch or the result is invalid. */
export function applyPatch(content: SiteContent, patch: unknown): SiteContent {
  const { contact, removePhotos, ...fields } = ContentPatch.parse(patch);
  const remove = new Set(removePhotos ?? []);
  return SiteContent.parse({
    ...content,
    ...fields,
    contact: { ...content.contact, ...contact },
    media: {
      ...content.media,
      photos: content.media.photos.filter((_, i) => !remove.has(i)),
    },
  });
}
