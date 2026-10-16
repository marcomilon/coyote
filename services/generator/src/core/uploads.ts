import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Media } from './content';
import type { Stores } from './jobs';
import { hashIp } from './ratelimit';

/** The browser resizes before uploading (logo ≤ 512 px PNG, photos ≤ 1600 px JPEG), so files are small. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTOS = 6;
const UPLOADS_PER_IP_PER_DAY = 20;

const FILES = {
  logo: { key: 'logo.png', contentType: 'image/png' },
  photo: { key: (n: number) => `photo-${n}.jpg`, contentType: 'image/jpeg' },
} as const;

const Body = z.object({ logo: z.boolean().optional(), photos: z.number().int().min(0).max(MAX_PHOTOS).optional() });

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadDeps {
  stores: Stores;
  ipSalt: string;
  presign(key: string, contentType: string, maxBytes: number): Promise<PresignedPost>;
  now(): number;
  newId(): string;
}

export type UploadsResult =
  | { status: 200; uploadId: string; logo?: PresignedPost; photos: PresignedPost[] }
  | { status: 400 }
  | { status: 429 };

/** POST /uploads: one-time upload slots. The file names and types are fixed by us, never by the client. */
export async function createUploads(body: unknown, ip: string, deps: UploadDeps): Promise<UploadsResult> {
  const parsed = Body.safeParse(body);
  if (!parsed.success || (!parsed.data.logo && !parsed.data.photos)) return { status: 400 };

  const now = deps.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const allowed = await deps.stores.hitRateLimit(`uploads#${hashIp(ip, deps.ipSalt)}#${day}`, UPLOADS_PER_IP_PER_DAY, Math.floor(now / 1000) + 2 * 86400);
  if (!allowed) return { status: 429 };

  const uploadId = deps.newId();
  const prefix = `_uploads/${uploadId}/`;
  return {
    status: 200,
    uploadId,
    logo: parsed.data.logo ? await deps.presign(prefix + FILES.logo.key, FILES.logo.contentType, MAX_UPLOAD_BYTES) : undefined,
    photos: await Promise.all(
      Array.from({ length: parsed.data.photos ?? 0 }, (_, i) => deps.presign(prefix + FILES.photo.key(i + 1), FILES.photo.contentType, MAX_UPLOAD_BYTES)),
    ),
  };
}

export interface ProcessDeps {
  stores: Stores;
  /** Resolves to the moderation labels that make an image unacceptable (empty = fine). Throws if it is not an image. */
  moderate(key: string): Promise<string[]>;
  /** The suffix that makes each kept file's name unique (tests pass a fixed one). */
  newFileId?: () => string;
}

export type ProcessResult = { ok: true; media: Media } | { ok: false; reason: string };

/**
 * Moderates every uploaded file, then copies the clean ones next to the page under new names (`logo-<id>.png`,
 * `photo-<id>.jpg`), so photos added later never overwrite ones a page uses. Anything flagged rejects the job.
 * `notes[i]` is what the owner says upload photo-(i+1) shows; it becomes that photo's caption.
 */
/** True when an upload holds only a logo (Mi sitio → Tus fotos: a new logo and nothing else). */
export async function onlyLogo(uploadId: string, stores: Pick<Stores, 'listKeys'>): Promise<boolean> {
  const prefix = `_uploads/${uploadId}/`;
  const names = (await stores.listKeys(prefix)).map((key) => key.slice(prefix.length));
  return names.length > 0 && names.every((name) => name === FILES.logo.key);
}

export async function processUploads(uploadId: string, targetPrefix: string, { stores, moderate, newFileId }: ProcessDeps, notes: string[] = []): Promise<ProcessResult> {
  const prefix = `_uploads/${uploadId}/`;
  const expected = new Map<string, string>([[FILES.logo.key, FILES.logo.contentType], ...Array.from({ length: MAX_PHOTOS }, (_, i) => [FILES.photo.key(i + 1), FILES.photo.contentType] as [string, string])]);
  const names = (await stores.listKeys(prefix))
    .map((key) => key.slice(prefix.length))
    .filter((name) => expected.has(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  for (const name of names) {
    let labels: string[];
    try {
      labels = await moderate(prefix + name);
    } catch {
      return { ok: false, reason: `${name}: not a valid image` };
    }
    if (labels.length > 0) return { ok: false, reason: `${name}: ${labels.join(', ')}` };
  }

  const media: Media = { photos: [] };
  for (const name of names) {
    const [base, ext] = name.split('.') as [string, string];
    const file = `assets/${base.replace(/-\d+$/, '')}-${(newFileId ?? (() => randomUUID().slice(0, 8)))()}.${ext}`;
    await stores.copyObject(prefix + name, `${targetPrefix}${file}`, expected.get(name)!);
    if (name === FILES.logo.key) media.logo = file;
    else {
      media.photos.push(file);
      const note = notes[Number(/\d+/.exec(name)![0]) - 1]?.trim();
      if (note) media.captions = { ...media.captions, [file]: note.slice(0, 100) };
    }
  }
  return { ok: true, media };
}

/**
 * The site's images after a photo change in Mi sitio: a new logo replaces the old one, new photos go last, and
 * `captions` changes the descriptions of the photos that stay ("" clears one).
 */
export function mergeMedia(current: Media, added: Media, remove: string[] = [], captions: Record<string, string> = {}): Media {
  const logo = added.logo ?? (current.logo && !remove.includes(current.logo) ? current.logo : undefined);
  const photos = [...current.photos.filter((p) => !remove.includes(p)), ...added.photos].slice(-MAX_PHOTOS);
  const all: Record<string, string> = { ...current.captions, ...captions, ...added.captions };
  const kept = Object.fromEntries(photos.flatMap((file) => (all[file]?.trim() ? [[file, all[file]!.trim().slice(0, 100)]] : [])));
  const { logo: _old, captions: _captions, ...rest } = current;
  return { ...rest, ...(logo && { logo }), photos, ...(Object.keys(kept).length > 0 && { captions: kept }) };
}
