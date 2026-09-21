import { z } from 'zod';
import type { SiteContent } from './content';
import type { Stores } from './jobs';
import { hashIp } from './ratelimit';

/** The browser resizes before uploading (logo ≤ 512 px PNG, photos ≤ 1600 px JPEG), so files are small. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTOS = 3;
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
}

export type Media = SiteContent['media'];
export type ProcessResult = { ok: true; media: Media } | { ok: false; reason: string };

/** Moderates every uploaded file, then copies the clean ones next to the page. Anything flagged rejects the job. */
export async function processUploads(uploadId: string, targetPrefix: string, { stores, moderate }: ProcessDeps): Promise<ProcessResult> {
  const prefix = `_uploads/${uploadId}/`;
  const expected = new Map<string, string>([[FILES.logo.key, FILES.logo.contentType], ...Array.from({ length: MAX_PHOTOS }, (_, i) => [FILES.photo.key(i + 1), FILES.photo.contentType] as [string, string])]);
  const names = (await stores.listKeys(prefix)).map((key) => key.slice(prefix.length)).filter((name) => expected.has(name)).sort();

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
    await stores.copyObject(prefix + name, `${targetPrefix}assets/${name}`, expected.get(name)!);
    if (name === FILES.logo.key) media.logo = `assets/${name}`;
    else media.photos.push(`assets/${name}`);
  }
  return { ok: true, media };
}
