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
  rejectedBy?: 'brand' | 'prescreen' | 'guardrail' | 'policy';
  rejectDetail?: string;
  usage: Usage[];
  previewUrl?: string;
  siteUrl?: string;
  error?: string;
}

export type SiteStatus = 'claimed' | 'preview' | 'published';

export interface SiteRecord {
  slug: string;
  status: SiteStatus;
  jobId: string;
  createdAt: number;
  content?: SiteContent;
  brief?: Brief;
  ownerWhatsApp?: string;
}

/** Everything the request flows need from DynamoDB and S3. Implemented in src/aws/stores.ts. */
export interface Stores {
  /** Counts one request for this key. Resolves to false when the daily limit is already reached. */
  hitRateLimit(key: string, max: number, ttl: number): Promise<boolean>;
  isBlocked(slug: string): Promise<boolean>;
  /** Atomic: resolves to false when the slug is already taken. */
  claimSlug(site: SiteRecord): Promise<boolean>;
  /** Frees a slug that never got a published site. */
  releaseSlug(slug: string, jobId: string): Promise<void>;
  /** Merges the given fields into the site record (never drops stored content). */
  saveSite(site: SiteRecord): Promise<void>;
  putJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | undefined>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<void>;
  putPage(key: string, page: string): Promise<void>;
  copyPrefix(from: string, to: string): Promise<void>;
}

export const JOB_TTL_SECONDS = 90 * 24 * 60 * 60;
/** A job still PENDING after this long is reported as FAILED. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 1000;

/** What the browser may see. Never the answers, the IP hash, or why something was rejected. */
export function publicJob(job: Job, now: number) {
  const status: JobStatus = job.status === 'PENDING' && now - job.createdAt > PENDING_TIMEOUT_MS ? 'FAILED' : job.status;
  return { jobId: job.jobId, status, slug: job.slug, previewUrl: job.previewUrl, siteUrl: job.siteUrl };
}
