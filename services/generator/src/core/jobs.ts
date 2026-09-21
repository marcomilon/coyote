import type { Answers } from './answers';
import type { Usage } from './bedrock';
import type { Brief } from './brief';
import type { SiteContent } from './content';

/** PENDING → DONE (preview ready) → PUBLISHED, or REJECTED (policy) / FAILED (our error). */
export type JobStatus = 'PENDING' | 'DONE' | 'PUBLISHED' | 'REJECTED' | 'FAILED';

export interface Job {
  jobId: string;
  status: JobStatus;
  /** ms since epoch */
  createdAt: number;
  /** DynamoDB TTL, seconds since epoch. Jobs are kept 90 days for abuse investigation. */
  ttl: number;
  ipHash: string;
  answers: Answers;
  slug?: string;
  screening?: { decision: string; category: string; confidence: number; reason: string };
  rejectedBy?: 'brand' | 'prescreen' | 'guardrail' | 'policy' | 'image';
  rejectDetail?: string;
  usage: Usage[];
  previewUrl?: string;
  siteUrl?: string;
  error?: string;
  /** What generation produced. Copied to the site record only when the owner publishes. */
  result?: { content: SiteContent; brief: Brief };
  /** Files the requester uploaded before submitting (`_uploads/<uploadId>/`). */
  uploadId?: string;
  /** A regeneration reuses the images of the previous version: the S3 prefix that holds its `assets/`. */
  assetsFrom?: string;
  /** A new version for a slug that already has a job. Never frees the slug. */
  regenerate?: boolean;
  /** Seeds the theme and font candidates. Defaults to the slug; regenerations vary it. */
  seed?: string;
}

/** quarantined: taken offline by visitor reports. blocked: removed by the admin for good. */
export type SiteStatus = 'claimed' | 'published' | 'unpublished' | 'quarantined' | 'blocked';

export interface SiteRecord {
  slug: string;
  status: SiteStatus;
  jobId: string;
  createdAt: number;
  content?: SiteContent;
  brief?: Brief;
  ownerWhatsApp?: string;
  /** sha256 of the magic-link secret. The secret itself is shown once and never stored. */
  tokenHash?: string;
  /** seconds since epoch */
  tokenExpiresAt?: number;
  regenCount?: number;
  /** Every job that produced a version of this site (for "delete my data"). */
  jobIds?: string[];
}

/** Everything the request flows need from DynamoDB and S3. Implemented in src/aws/stores.ts. */
export interface Stores {
  /** Counts one request for this key. Resolves to false when the daily limit is already reached. */
  hitRateLimit(key: string, max: number, ttl: number): Promise<boolean>;
  isBlocked(slug: string): Promise<boolean>;
  block(slug: string): Promise<void>;
  /** Resolves to true only the first time a key is seen. */
  putOnce(key: string, ttl: number): Promise<boolean>;
  /** Adds one to a counter and resolves to the new value. */
  increment(key: string, ttl: number): Promise<number>;
  /** Atomic: resolves to false when the slug is already taken. */
  claimSlug(site: SiteRecord): Promise<boolean>;
  /** Frees a slug that never got a published site. */
  releaseSlug(slug: string, jobId: string): Promise<void>;
  /** Merges the given fields into the site record (never drops stored content). */
  saveSite(site: Partial<SiteRecord> & { slug: string }): Promise<void>;
  getSite(slug: string): Promise<SiteRecord | undefined>;
  deleteSite(slug: string): Promise<void>;
  /** Removes the requester's text from a job, keeping the safety outcome. */
  redactJob(jobId: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Drops the CDN's cached copy of a site, so a change or a removal shows at once instead of after the cache TTL. */
  invalidateSite(slug: string): Promise<void>;
  putJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | undefined>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<void>;
  putPage(key: string, page: string): Promise<void>;
  copyPrefix(from: string, to: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
  /** Copies one object and sets the content type it is served with. */
  copyObject(from: string, to: string, contentType: string): Promise<void>;
}

export const JOB_TTL_SECONDS = 90 * 24 * 60 * 60;
/** A job still PENDING after this long is reported as FAILED. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 1000;

/** What the browser may see. Never the answers, the IP hash, or why something was rejected. */
export function publicJob(job: Job, now: number) {
  const status: JobStatus = job.status === 'PENDING' && now - job.createdAt > PENDING_TIMEOUT_MS ? 'FAILED' : job.status;
  return { jobId: job.jobId, status, slug: job.slug, previewUrl: job.previewUrl, siteUrl: job.siteUrl };
}
