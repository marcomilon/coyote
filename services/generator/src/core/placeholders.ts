/**
 * The placeholder contract between the model and fill.ts. The model writes these; our code fills them from
 * the owner's contact details and images, so a contact detail on the page always equals what the owner typed.
 */

/** Allowed as the whole value of `<a href>`. */
export const URL_PLACEHOLDERS = ['whatsapp_url', 'phone_url', 'email_url', 'maps_url', 'instagram_url', 'facebook_url'] as const;

/** Allowed inside text. */
export const TEXT_PLACEHOLDERS = ['whatsapp_display', 'phone_display', 'email_display', 'instagram_display', 'facebook_display', 'address'] as const;

/** A link placeholder written as visible text is a slip, not an attack: the sanitizer shows the display value instead. */
export const DISPLAY_FOR_URL: Record<UrlPlaceholder, TextPlaceholder> = {
  whatsapp_url: 'whatsapp_display',
  phone_url: 'phone_display',
  email_url: 'email_display',
  maps_url: 'address',
  instagram_url: 'instagram_display',
  facebook_url: 'facebook_display',
};

/** Allowed as the whole value of `<img src>` and inside CSS `url()`. */
export const IMAGE_PLACEHOLDERS = ['logo', 'hero', 'photo:1', 'photo:2', 'photo:3'] as const;

export type UrlPlaceholder = (typeof URL_PLACEHOLDERS)[number];
export type TextPlaceholder = (typeof TEXT_PLACEHOLDERS)[number];
export type ImagePlaceholder = (typeof IMAGE_PLACEHOLDERS)[number];

/** Any `{{…}}` token. Anything not in the lists above is rejected by the sanitizer. */
export const PLACEHOLDER = /\{\{([^{}]{0,40})\}\}/g;

/**
 * `data-needs="phone_url email_url"` on any element: fill.ts removes it unless every listed placeholder has
 * a value. Lets the model wrap a label and its link together.
 */
export const NEEDS_ATTRIBUTE = 'data-needs';

/** The element fill.ts puts the Google map into. */
export const MAP_SLOT = { attribute: 'data-slot', value: 'map' } as const;

/** `{{name}}` → name, when the whole value is one placeholder. */
export function wholePlaceholder(value: string): string | undefined {
  return /^\{\{([^{}]{1,40})\}\}$/.exec(value.trim())?.[1];
}

export const isUrlPlaceholder = (name: string | undefined): name is UrlPlaceholder => (URL_PLACEHOLDERS as readonly string[]).includes(name ?? '');
export const isTextPlaceholder = (name: string): name is TextPlaceholder => (TEXT_PLACEHOLDERS as readonly string[]).includes(name);
export const isImagePlaceholder = (name: string | undefined): name is ImagePlaceholder => (IMAGE_PLACEHOLDERS as readonly string[]).includes(name ?? '');
