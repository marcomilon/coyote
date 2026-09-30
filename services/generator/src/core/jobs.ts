import type { Answers } from './answers';
import type { Usage } from './bedrock';
import type { Media } from './content';
import type { Note, Question } from './questions';

/**
 * PENDING → (NEEDS_INPUT → PENDING) → DONE (draft written), or REJECTED (policy) / FAILED (our error).
 * NEEDS_INPUT: the model asked questions; the owner answers or skips them, then the job runs again.
 */
export type JobStatus = 'PENDING' | 'NEEDS_INPUT' | 'DONE' | 'REJECTED' | 'FAILED';

export interface Job {
  jobId: string;
  status: JobStatus;
  /** ms since epoch */
  createdAt: number;
  /** ms since epoch: when the job last became PENDING (the stuck-job cutoff counts from here). */
  startedAt?: number;
  /** DynamoDB TTL, seconds since epoch. Jobs are kept 90 days for abuse investigation. */
  ttl: number;
  ipHash: string;
  /** The form answers. For an edit, the site's answers at the time of the request. */
  answers: Answers;
  slug?: string;
  /** create: a new site from the form. edit: a free-text change to an existing site. */
  kind?: 'create' | 'edit';
  /** The owner's change request (edit jobs). */
  instruction?: string;
  /** clarify: may ask questions first. write: must build now (only one round of questions). */
  stage?: 'clarify' | 'write';
  questions?: Question[];
  /** Free-text answers to the questions. Contact answers go into `answers.contact` instead. */
  notes?: Note[];
  screening?: { decision: string; category: string; confidence: number; reason: string };
  rejectedBy?: 'brand' | 'prescreen' | 'guardrail' | 'policy' | 'image';
  rejectDetail?: string;
  usage: Usage[];
  draftUrl?: string;
  /** The site's stable preview URL (drafts.ts `refreshPreview`). */
  previewUrl?: string;
  /** The magic-link token of a new site. Handed to the browser once by GET /jobs/{id}, then removed. */
  ownerToken?: string;
  error?: string;
  /** The site's images once moderated (`_media/<slug>/`), kept between the clarify and write stages. */
  media?: Media;
  /** Files the requester uploaded before submitting (`_uploads/<uploadId>/`). */
  uploadId?: string;
  /** Create jobs: the owner's email (account.ts). Never sent to a model. */
  ownerEmail?: string;
}

/** quarantined: taken offline by visitor reports. blocked: removed by the admin for good. */
export type SiteStatus = 'claimed' | 'draft' | 'published' | 'quarantined' | 'blocked';

export interface SiteRecord {
  slug: string;
  status: SiteStatus;
  jobId: string;
  createdAt: number;
  ownerWhatsApp?: string;
  /** sha256 of the magic-link secret. The secret itself is shown once and never stored. */
  tokenHash?: string;
  /** seconds since epoch */
  tokenExpiresAt?: number;
  /** The version the owner sees (drafts.ts). */
  currentDraftId?: string;
  /** The last few versions, oldest first; the last one is current. */
  drafts?: string[];
  /** Every job that produced a version of this site (for "delete my data"). */
  jobIds?: string[];
  /** The owner's account (account.ts): `emailId` of the email given in the form. */
  ownerEmailId?: string;
  /** The stable preview (`_draft/<previewId>/`): always a copy of the current draft (drafts.ts). */
  previewId?: string;
}

/** The sites linked to one email (account.ts). */
export interface Account {
  email: string;
  lang: 'es' | 'pt';
  sites: { slug: string; businessName: string; createdAt: number }[];
}

/** A sign-in link (single use) or a session. Only the hash of its secret is stored. */
export interface AccountToken {
  kind: 'login' | 'session';
  /** login: the hash of the secret. session: a random ID sent next to the secret. */
  id: string;
  emailId: string;
  secretHash?: string;
  /** ms since epoch */
  expiresAt: number;
}

/**
 * One message of a site's chat (chat.ts). The owner writes; Coyote's reply starts `pending` and the chat
 * Lambda fills it in. `at` (ms) orders the messages and is unique per site.
 */
export interface ChatMessage {
  slug: string;
  at: number;
  role: 'owner' | 'coyote';
  text: string;
  status: 'pending' | 'done' | 'failed';
  /** The draft this reply made, when it changed the page. */
  draftId?: string;
  /** A change too big for the chat: the request to hand to the page writer ("Rediseñar"). */
  redesign?: string;
  /** DynamoDB TTL, seconds since epoch. */
  ttl: number;
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
  /** Frees a slug that is still only claimed (no draft yet) by this job. */
  releaseSlug(slug: string, jobId: string): Promise<void>;
  /** Merges the given fields into the site record. */
  saveSite(site: Partial<SiteRecord> & { slug: string }): Promise<void>;
  getSite(slug: string): Promise<SiteRecord | undefined>;
  deleteSite(slug: string): Promise<void>;
  /** Removes the requester's text from a job, keeping the safety outcome. */
  redactJob(jobId: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Drops the CDN's cached copy of a site, so a change or a removal shows at once instead of after the cache TTL. */
  invalidateSite(slug: string): Promise<void>;
  /** Same, for any paths ("/_draft/<id>/*"). */
  invalidatePaths(paths: string[]): Promise<void>;
  putJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | undefined>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<void>;
  /** Atomic: applies the patch only if the job is still in `from`. Resolves to false otherwise. */
  transitionJob(jobId: string, from: JobStatus, patch: Partial<Job>): Promise<boolean>;
  /** Removes the owner token from a job and resolves to it (only the first caller gets it). */
  takeOwnerToken(jobId: string): Promise<string | undefined>;
  /** A served page. Cached 5 minutes unless `cacheControl` says otherwise. */
  putPage(key: string, page: string, cacheControl?: string): Promise<void>;
  putAsset(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** An object that is never served (sources, site records). */
  putPrivate(key: string, body: string, contentType: string): Promise<void>;
  getText(key: string): Promise<string | undefined>;
  getBytes(key: string): Promise<Uint8Array | undefined>;
  copyPrefix(from: string, to: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
  /** Copies one object and sets the content type it is served with. */
  copyObject(from: string, to: string, contentType: string): Promise<void>;
  putChat(message: ChatMessage): Promise<void>;
  updateChat(slug: string, at: number, patch: Partial<ChatMessage>): Promise<void>;
  /** The newest `limit` messages after `at`, oldest first. */
  listChat(slug: string, after: number, limit: number): Promise<ChatMessage[]>;
  deleteChat(slug: string): Promise<void>;
  /** Adds a site to the account of an email (created with the first site). */
  linkAccountSite(emailId: string, email: string, lang: 'es' | 'pt', site: Account['sites'][number]): Promise<void>;
  getAccount(emailId: string): Promise<Account | undefined>;
  /** Removes a site; the account itself goes with its last site. */
  unlinkAccountSite(emailId: string, slug: string): Promise<void>;
  putAccountToken(token: AccountToken): Promise<void>;
  getAccountToken(kind: AccountToken['kind'], id: string): Promise<AccountToken | undefined>;
  /** Atomic: removes the token and resolves to it (only the first caller gets it). */
  takeAccountToken(kind: AccountToken['kind'], id: string): Promise<AccountToken | undefined>;
}

export const JOB_TTL_SECONDS = 90 * 24 * 60 * 60;
/** A job still PENDING after this long is reported as FAILED. The generate Lambda times out at 5 minutes. */
export const PENDING_TIMEOUT_MS = 12 * 60 * 1000;

/** What the browser may see. Never the answers, the IP hash, or why something was rejected. */
export function publicJob(job: Job, now: number) {
  const stuck = job.status === 'PENDING' && now - (job.startedAt ?? job.createdAt) > PENDING_TIMEOUT_MS;
  return {
    jobId: job.jobId,
    status: stuck ? ('FAILED' as const) : job.status,
    kind: job.kind ?? 'create',
    slug: job.slug,
    lang: job.answers.lang,
    /** clarify: questions may still come. write: none left (the owner may close the page). */
    stage: job.stage ?? 'clarify',
    questions: job.status === 'NEEDS_INPUT' ? job.questions : undefined,
    draftUrl: job.status === 'DONE' ? job.draftUrl : undefined,
    previewUrl: job.status === 'DONE' ? job.previewUrl : undefined,
  };
}
