import type { Stores } from './jobs';

/** Text to image. Resolves to JPEG bytes, or undefined when the model filtered the prompt. */
export type GenerateImage = (prompt: string, negativePrompt: string) => Promise<Uint8Array | undefined>;

export interface HeroDeps {
  stores: Stores;
  generateImage: GenerateImage;
  /** Resolves to the moderation labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
  /** Output guardrail on the scene text. */
  outputAllowed(text: string): Promise<boolean>;
}

export const HERO_FILE = 'photo-1.jpg';

const STYLE = 'documentary photography, natural colors, soft natural light, shallow depth of field';
export const HERO_NEGATIVE = 'text, letters, words, signage, logos, watermark, people, faces, hands, cartoon, illustration, 3d render';

export const heroPrompt = (scene: string) => `${scene.trim().replace(/\.$/, '')}. ${STYLE}`;

/**
 * Generates the hero photo for a site with no uploaded photos and writes it to `<prefix>assets/`.
 * Resolves to its asset path, or undefined when there is none: an image is decoration, so a filtered
 * prompt, a flagged image, or a model error leaves the page without one instead of failing the job.
 */
export async function generateHero(scene: string, targetPrefix: string, deps: HeroDeps): Promise<string | undefined> {
  try {
    if (!(await deps.outputAllowed(scene))) return undefined;
    const bytes = await deps.generateImage(heroPrompt(scene), HERO_NEGATIVE);
    if (!bytes) return undefined;
    const key = `${targetPrefix}assets/${HERO_FILE}`;
    await deps.stores.putAsset(key, bytes, 'image/jpeg');
    if ((await deps.moderate(key)).length > 0) {
      await deps.stores.deletePrefix(key); // publishing copies the whole preview folder
      return undefined;
    }
    return `assets/${HERO_FILE}`;
  } catch (error) {
    console.error('hero image failed', { error });
    return undefined;
  }
}
