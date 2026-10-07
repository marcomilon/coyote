import { z } from 'zod';
import { validForCountry } from './phones';

const text = (max: number) => z.string().trim().min(1).max(max);

const phone = z.string().regex(/^[1-9]\d{7,14}$/, 'digits only, with country code');
/** WhatsApp numbers must also have the right length for their country (phones.ts). */
const whatsapp = phone.refine(validForCountry, 'wrong number of digits for its country');

/**
 * The business's public contact details. Copied from what the owner typed (the form, a contact question,
 * or the chat), never from model output. page-check.ts allows them on the page and swaps them in.
 */
export const Contact = z.object({
  whatsapp,
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
  /** The owner's uploaded photos. */
  photos: z.array(assetPath).max(3),
});
export type Media = z.infer<typeof Media>;
