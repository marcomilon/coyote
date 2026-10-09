import { randomUUID } from 'node:crypto';
import type { Stores } from './jobs';
import type { ImageAspect, MakeImage } from './page-writer';

/** Text to image. Resolves to JPEG bytes, or undefined when the model filtered the prompt. */
export type GenerateImage = (prompt: string, negativePrompt: string, aspect: ImageAspect) => Promise<Uint8Array | undefined>;

/** Photos per page (each $0.04 and about 10 s). */
export const MAX_IMAGES = 4;

/** The image model cannot spell, and a made-up shop sign or logo would be the business's name written wrong. */
export const IMAGE_NEGATIVE = 'text, letters, words, signage, logos, watermark';

export interface ImageDeps {
  stores: Pick<Stores, 'putAsset' | 'deletePrefix'>;
  generateImage: GenerateImage;
  /** Resolves to the moderation labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
  /** Output guardrail on the scene text. */
  outputAllowed(text: string): Promise<boolean>;
}

/**
 * The make_image tool for one page: the scene passes the guardrail, the photo is made, saved as
 * `<prefix>assets/gen-<id>.jpg`, and passes image moderation. `made` collects the files (for Media.generated).
 */
export function imageMaker(prefix: string, deps: ImageDeps, made: string[] = []): MakeImage {
  let started = 0;
  return async ({ description, aspect }) => {
    if (started >= MAX_IMAGES) return { error: `the limit of ${MAX_IMAGES} photos per page is reached` };
    started++;
    if (!(await deps.outputAllowed(description))) return { error: 'the scene was refused' };
    const bytes = await deps.generateImage(description, IMAGE_NEGATIVE, aspect);
    if (!bytes) return { error: 'the image model refused the scene' };
    const file = `assets/gen-${randomUUID().slice(0, 8)}.jpg`;
    const key = `${prefix}${file}`;
    await deps.stores.putAsset(key, bytes, 'image/jpeg');
    if ((await deps.moderate(key)).length > 0) {
      await deps.stores.deletePrefix(key);
      return { error: 'the photo did not pass moderation' };
    }
    made.push(file);
    return { file, bytes };
  };
}
