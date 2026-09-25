import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const phone = z.string().regex(/^[1-9]\d{7,14}$/, 'digits only, with country code');

/**
 * The business's public contact details. Copied from what the owner typed (the form, a contact question,
 * or Mi sitio), never from model output. They reach the page only through placeholders (fill.ts).
 */
export const Contact = z.object({
  whatsapp: phone,
  phone: phone.optional(),
  email: z.email().max(120).optional(),
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

/** Images next to the page. The files live in `_media/<slug>/assets/` and are copied into every draft. */
export const Media = z.object({
  logo: assetPath.optional(),
  photos: z.array(assetPath).max(3),
  /** Generated when there are no photos. Fills `{{hero}}`. */
  hero: assetPath.optional(),
});
export type Media = z.infer<typeof Media>;
