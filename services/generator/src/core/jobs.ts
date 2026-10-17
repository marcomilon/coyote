import type { Answers } from './answers';
import type { Usage } from './bedrock';
import type { Media } from './content';
import type { UsageCount } from './email-usage';
import type { ModelTier } from './models';
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
  /** The question about what the business sells, when the answers did not say: the owner must answer it (no skip). */
  requiredQuestion?: string;
  /** Free-text answers to the questions. Contact answers go into `answers.contact` instead. */
  notes?: Note[];
  screening?: { decision: string; category: string; confidence: number; clarity?: string; offers?: boolean; reason: string };
  /** unclear: no real business described; the owner was asked to describe it again (not a policy rejection). */
  /** limit: the owner's email already used its free draft (free-draft.ts) or its paid writes (paid-writes.ts). */
  rejectedBy?: 'brand' | 'prescreen' | 'guardrail' | 'policy' | 'image' | 'unclear' | 'limit';
  /** Create jobs: this job used the email's free draft (given back if the job fails). */
  freeDraft?: boolean;
  /** The tier of the model that wrote the page (models.ts): only a paid write uses the free draft. */
  tier?: ModelTier;
  /** A paid-tier write: the email hash whose paid write it used (paid-writes.ts; given back if the job fails). */
  paidWrite?: string;
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
  /** Files the requester uploaded before submitting (`_uploads/<uploadId>/`). Edit jobs: photos added in Mi sitio. */
  uploadId?: string;
  /** Edit jobs: the site's images the owner took out in Mi sitio. */
  removePhotos?: string[];
  /** Edit jobs: new descriptions of the site's photos, by file ("" clears one). */
  captions?: Record<string, string>;
  /** Edit jobs: what the photos added in Mi sitio show, in upload order. */
  newCaptions?: string[];
  /** Edit jobs: made photos (`assets/gen-…`) the owner's uploaded photos replace, in upload order, with no page writer. */
  replaceMade?: string[];
  /** Edit jobs: a new logo only, swapped for the one the page shows, with no page writer. */
  swapLogo?: boolean;
  /** Edit jobs: the photo change once moderated, kept between the clarify and write stages. */
  /** placed: a new logo put in the page's tagged logo spot (logo.ts), with no page writer. */
  photoChange?: { added: string[]; removed: string[]; described?: string[]; replaced?: string[]; placed?: string };
  /** Create jobs: the owner's email (account.ts). Never sent to a model. */
  ownerEmail?: string;
  /** Edit jobs: the `at` of the chat note that follows this redesign (chat-notes.ts). */
  chatAt?: number;
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
  /** Every design the page writer made (the first page, then each redesign), oldest first; each points at its latest version (drafts.ts). */
  designs?: Design[];
  /** Every job that produced a version of this site (for "delete my data"). */
  jobIds?: string[];
  /** The owner's account (account.ts): `emailId` of the email given in the form. */
  ownerEmailId?: string;
  /** The stable preview (`_draft/<previewId>/`): always a copy of the current draft (drafts.ts). */
  previewId?: string;
  /** The owner's own domain (domains.ts), set when its registration starts. */
  domain?: string;
  /** The site's monthly plan (payments.ts), mirrored from Paddle's subscription webhooks. */
  billing?: Billing;
  /** The domain paid for with the plan, until it is registered (domains.ts `runDomainOrder`). */
  domainOrder?: DomainOrder;
}

/** A domain to register once the plan is paid. `failed`: the refusal that retrying can't fix (we get an alert). */
export interface DomainOrder {
  domain: string;
  /** ms since epoch */
  at: number;
  failed?: string;
}

/** A Paddle subscription, as its latest webhook described it. */
export interface Billing {
  subscriptionId: string;
  customerId: string;
  /** Paddle's status: active, trialing, past_due, paused, canceled. */
  status: string;
  /** ISO date of the next charge, while there is one. */
  nextBilledAt?: string;
  /** ms since epoch: when Paddle sent the event this came from (older events never overwrite newer ones). */
  updatedAt: number;
}

/**
 * A domain registered for a site (domains.ts). registering: claimed, the registrar not yet called back.
 * setup_pending: registered and paid, auto-renew not yet off. Coyote is the registrant. Kept when the site is deleted.
 */
export interface DomainRecord {
  domain: string;
  slug: string;
  status: 'registering' | 'setup_pending' | 'registered';
  /** ms since epoch */
  createdAt: number;
  registeredAt?: number;
  /** ms since epoch */
  expiresAt?: number;
  priceCents: number;
  /** The owner's account email, to reach them about the domain. */
  ownerEmail?: string;
  /** Serving the site on the domain (hosting.ts), once it is registered. */
  hosting?: Hosting;
}

/**
 * The hosting setup's progress (hosting.ts), one step at a time: publish → dns → tenant → cert → live.
 * failed: a refusal retrying can't fix (we get an alert).
 */
export interface Hosting {
  step: 'publish' | 'dns' | 'tenant' | 'cert' | 'live';
  /** The CloudFront distribution tenant serving the domain. */
  tenantId?: string;
  /** Managed certificate requests made (one retry after a timeout). */
  certRequests?: number;
  failed?: string;
  /** ms since epoch: the last step change. */
  at: number;
  liveAt?: number;
}

/** Fields to change. */
export type DomainPatch = Partial<Omit<DomainRecord, 'domain'>> & { domain: string };

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
  /** The owner undid that draft ("Deshacer"): the change is no longer on the page. */
  undone?: boolean;
  /** A change too big for the chat: the request to hand to the page writer ("Rediseñar"). */
  redesign?: string;
  /** The owner pressed "Rediseñar" on this reply (POST /me/edit with `from`): the button is spent. */
  redesignStarted?: boolean;
  /** A redesign asked for with no designs left: the reply offers the design pack instead. */
  buyDesigns?: boolean;
  /** A redesign's note (chat-notes.ts): the edit job it follows. */
  jobId?: string;
  /** DynamoDB TTL, seconds since epoch. */
  ttl: number;
}

/**
 * A complete page the page writer made: the first one, or a redesign the owner asked for. Updates (texts, contact,
 * photos, the chat) are new versions of the current design. The owner picks the design the site uses (Mi sitio → Diseños).
 */
export interface Design {
  /** The draft that started it. */
  id: string;
  /** Its latest version. */
  draftId: string;
  at: number;
  kind: 'create' | 'redesign';
  /** The owner's request, for a redesign. */
  request?: string;
  /** What the design used, so a later redesign of the site uses something else (generate-job.ts). */
  look?: DesignLook;
}

export interface DesignLook {
  /** The page structure (page-writer.ts LAYOUTS); unset for a first design, which picks freely. */
  layout?: string;
  tones: string[];
  dark: boolean;
  fonts: string[];
  /** Template mode: the template it filled. */
  template?: string;
}

/** Everything the request flows need from DynamoDB and S3. Implemented in src/aws/stores.ts. */
export interface Stores {
  /** Counts one request for this key. Resolves to false when the daily limit is already reached. */
  hitRateLimit(key: string, max: number, ttl: number): Promise<boolean>;
  /** Gives back one request counted by hitRateLimit. */
  releaseRateLimit(key: string): Promise<void>;
  /** The current count of a hitRateLimit key (0 when unseen). */
  getCount(key: string): Promise<number>;
  isBlocked(slug: string): Promise<boolean>;
  block(slug: string): Promise<void>;
  /** Resolves to true only the first time a key is seen. */
  putOnce(key: string, ttl: number): Promise<boolean>;
  /** Adds one to a counter and resolves to the new value. */
  increment(key: string, ttl: number): Promise<number>;
  /** Atomic: adds `n` to a counter only the first time `onceKey` is seen. Resolves to false when it was seen. */
  addOnce(onceKey: string, key: string, n: number, ttl: number): Promise<boolean>;
  /** Adds model calls to a usage counter (email-usage.ts). */
  addUsage(key: string, count: UsageCount, ttl: number): Promise<void>;
  /** A usage counter (zeros when unseen). */
  getUsage(key: string): Promise<UsageCount>;
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
  /** Atomic: saves the record and sets `domain` on its site. False if the domain is taken or the site already has one. */
  claimDomain(record: DomainRecord): Promise<boolean>;
  /** Undoes claimDomain (the registration never happened). */
  releaseDomain(domain: string, slug: string): Promise<void>;
  saveDomain(patch: DomainPatch): Promise<void>;
  getDomain(domain: string): Promise<DomainRecord | undefined>;
  /** Sets the site's plan unless a newer event already did, or the site is gone. Resolves to false then. */
  saveBilling(slug: string, billing: Billing): Promise<boolean>;
  /** Atomic: sets the site's domain order unless it has one, or a domain. Resolves to false then (or when the site is gone). */
  orderDomain(slug: string, order: DomainOrder): Promise<boolean>;
  clearDomainOrder(slug: string): Promise<void>;
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
    /** The question the owner must answer; there is no skip. */
    requiredQuestion: job.status === 'NEEDS_INPUT' ? job.requiredQuestion : undefined,
    draftUrl: job.status === 'DONE' ? job.draftUrl : undefined,
    previewUrl: job.status === 'DONE' ? job.previewUrl : undefined,
    /** Not a policy rejection: the email already has its free draft. */
    hasDraft: job.status === 'REJECTED' && job.rejectedBy === 'limit' ? true : undefined,
  };
}
