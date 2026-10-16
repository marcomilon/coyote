import { randomUUID } from 'node:crypto';
import type { Stores } from './jobs';
import type { ImageAspect, MakeImage } from './page-writer';

/** Text to image. Resolves to JPEG bytes, or undefined when the model filtered the prompt. */
export type GenerateImage = (prompt: string, negativePrompt: string, aspect: ImageAspect) => Promise<Uint8Array | undefined>;

/** Photos per page (each $0.04 and about 10 s). */
export const MAX_IMAGES = 4;

/**
 * The image model cannot spell, and a made-up shop sign or logo would be the business's name written wrong.
 * It also draws hands with extra or missing fingers, even with this list: scenes avoid hands, and hands.ts checks each photo.
 */
export const IMAGE_NEGATIVE = 'text, letters, words, signage, logos, watermark, deformed hands, extra fingers, missing fingers, fused fingers';

/**
 * The words in Rekognition's DetectText result that count as writing: whole words of at least 3 letters it is sure of.
 * Stray digits and shapes that look like a letter or two in a pattern or a texture don't refuse a photo.
 */
export function legibleWords(detections: { Type?: string; DetectedText?: string; Confidence?: number }[]): string[] {
  return detections
    .filter((d) => d.Type === 'WORD' && (d.Confidence ?? 0) >= 80 && (d.DetectedText?.match(/\p{L}/gu)?.length ?? 0) >= 3)
    .map((d) => d.DetectedText!);
}

export interface ImageDeps {
  stores: Pick<Stores, 'putAsset' | 'deletePrefix'>;
  generateImage: GenerateImage;
  /** Resolves to the moderation labels that make an image unacceptable. */
  moderate(key: string): Promise<string[]>;
  /** Resolves to the words legible in an image. Unset: not checked. */
  readText?(key: string): Promise<string[]>;
  /** Output guardrail on the scene text. */
  outputAllowed(text: string): Promise<boolean>;
  /** Resolves to true when a hand in the photo is drawn wrong (hands.ts). Unset: not checked. */
  checkHands?(bytes: Uint8Array): Promise<boolean>;
}

/**
 * The make_image tool for one page: the scene passes the guardrail, the photo is made, saved as
 * `<prefix>assets/gen-<id>.jpg`, and passes image moderation and a text check: the model misspells whatever it writes
 * (and in English), so a photo with legible words is refused. `made` collects the files (for Media.generated).
 * Every result says how many photos are left: a refused scene uses one up too, a failed image model call doesn't.
 */
/** Width over height of a made photo, from its name (`gen-<id>-16x9.jpg`). Undefined for names without it. */
export function madeRatio(file: string): number | undefined {
  const match = /gen-[0-9a-f]+-(\d+)x(\d+)\./.exec(file);
  return match ? Number(match[1]) / Number(match[2]) : undefined;
}

/** Width over height of a PNG or JPEG, from its header. Undefined for anything else. */
export function imageRatio(bytes: Uint8Array): number | undefined {
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const u32 = (i: number) => u16(i) * 65536 + u16(i + 2);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return u32(16) / u32(20) || undefined;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // A start-of-frame segment holds the size: precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return u16(i + 7) / u16(i + 5) || undefined;
    i += 2 + u16(i + 2);
  }
  return undefined;
}

export function imageMaker(prefix: string, deps: ImageDeps, made: string[] = []): MakeImage {
  let started = 0;
  return async ({ description, aspect }) => {
    if (started >= MAX_IMAGES) return { error: `the limit of ${MAX_IMAGES} photos per page is reached`, left: 0 };
    const left = MAX_IMAGES - ++started;
    if (!(await deps.outputAllowed(description))) return { error: 'the scene was refused', left };
    const bytes = await deps.generateImage(description, IMAGE_NEGATIVE, aspect).catch((error: unknown) => {
      started--; // our bug or an outage, not the scene: give the photo back
      throw error;
    });
    if (!bytes) return { error: 'the image model refused the scene', left };
    // The shape goes in the name, so a redesign can tell which owner's photo fits its place (madeRatio).
    const file = `assets/gen-${randomUUID().slice(0, 8)}-${aspect.replace(':', 'x')}.jpg`;
    const key = `${prefix}${file}`;
    await deps.stores.putAsset(key, bytes, 'image/jpeg');
    if ((await deps.moderate(key)).length > 0) {
      await deps.stores.deletePrefix(key);
      return { error: 'the photo did not pass moderation', left };
    }
    if (deps.readText && (await deps.readText(key)).length > 0) {
      await deps.stores.deletePrefix(key);
      return { error: 'the photo had writing in it (the image model misspells everything): pick a scene with no signs, labels, menus, or storefronts', left };
    }
    if (deps.checkHands && (await deps.checkHands(bytes))) {
      await deps.stores.deletePrefix(key);
      return { error: 'the photo drew a hand wrong (the image model often gets fingers wrong): pick a scene where no hands show', left };
    }
    made.push(file);
    return { file, bytes, left };
  };
}
