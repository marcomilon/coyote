import { z } from 'zod';
import { normalizeAnswers, type Answers } from './answers';
import { GuardrailBlocked, type CallTool } from './bedrock';
import { findBrand } from './brands';
import { passesCaptcha, TOKEN_MAX, type VerifyHuman } from './captcha';
import { JOB_TTL_SECONDS, type Job, type Stores } from './jobs';
import { announceRejection, type Announce } from './notices';
import { isOurExample } from './example-about';
import { countUsage } from './email-usage';
import { emailId } from './token';
import { hasFreeDraftLeft } from './free-draft';
import { isFrozen, noteRefusal } from './freeze';
import type { ModelTier } from './models';
import { isRejected, isUnclear, prescreen } from './prescreen';
import { hashIp, rateLimitKey } from './ratelimit';
import { rejectSlug, slugify, withSuffix } from './slug';

/** The request body. Lengths are capped here so an oversized payload never reaches a model. */
const Body = z.object({
  businessName: z.string().max(200),
  about: z.string().max(2000),
  whatsapp: z.string().max(40),
  email: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  instagram: z.string().max(200).optional(),
  facebook: z.string().max(200).optional(),
  lang: z.string().max(5).optional(),
  aiImages: z.boolean().optional(),
  goal: z.string().max(20).optional(),
  photoNotes: z.array(z.string().max(200)).max(6).optional(),
  uploadId: z.string().uuid().optional(),
  /** The owner's email (account.ts): links the site to "Mis sitios". Not an answer: never sent to a model. */
  ownerEmail: z.email().max(120),
  /** The CAPTCHA token (captcha.ts). */
  turnstileToken: z.string().max(TOKEN_MAX).optional(),
});

export interface SubmitDeps {
  stores: Stores;
  callTool: CallTool;
  modelId: string;
  rateLimitPerDay: number;
  ipSalt: string;
  /** Notices for the admin (notices.ts). */
  announce?: Announce;
  /** The CAPTCHA (captcha.ts). Undefined: no check. */
  verifyHuman?: VerifyHuman;
  /** The tier of the model that will write the page (models.ts). Undefined: paid. A free write skips the free-draft check. */
  pageTier?(): Promise<ModelTier>;
  /** Starts the generate Lambda asynchronously. */
  startGenerate(jobId: string): Promise<void>;
  now(): number;
  newId(): string;
}

export type SubmitResult =
  | { status: 202; jobId: string }
  | { status: 400; fields: string[] }
  | { status: 403 }
  /** The email already used its free draft (free-draft.ts) and a paid-tier model writes pages. */
  | { status: 409 }
  /** unclear: the description names no real business; the owner is asked to describe it again. */
  | { status: 422; unclear?: true }
  /** The email's account is frozen (freeze.ts). */
  | { status: 423 }
  | { status: 429 };

const SLUG_ATTEMPTS = 5;

/**
 * Order matters: validation, the CAPTCHA, and the rate limit cost nothing, so they run before the model call.
 * A rejected request is still recorded (answers, IP hash, reason) for abuse investigation.
 */
export async function submit(body: unknown, ip: string, deps: SubmitDeps): Promise<SubmitResult> {
  const { stores } = deps;

  let answers: Answers;
  let uploadId: string | undefined;
  let ownerEmail: string;
  let token: string | undefined;
  try {
    const parsed = Body.parse(body);
    uploadId = parsed.uploadId;
    token = parsed.turnstileToken;
    ownerEmail = parsed.ownerEmail.trim().toLowerCase();
    answers = normalizeAnswers(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, fields: [...new Set(error.issues.map((i) => i.path.join('.')))] };
    throw error;
  }

  if (!(await passesCaptcha(deps.verifyHuman, token, ip))) return { status: 403 };
  if (await isFrozen(stores, emailId(ownerEmail))) return { status: 423 };
  if ((await deps.pageTier?.()) !== 'free' && !(await hasFreeDraftLeft(stores, ownerEmail))) return { status: 409 };
  // Our own example, copied back: no model call, no count.
  if (isOurExample(answers.about)) return { status: 422, unclear: true };

  const now = deps.now();
  const ipHash = hashIp(ip, deps.ipSalt);
  const limit = rateLimitKey(ipHash, now);
  if (!(await stores.hitRateLimit(limit.key, deps.rateLimitPerDay, limit.ttl))) return { status: 429 };

  const job: Job = {
    jobId: deps.newId(),
    status: 'PENDING',
    createdAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
    ipHash,
    answers,
    uploadId,
    ownerEmail,
    usage: [],
  };
  const reject = async (rejectedBy: Job['rejectedBy'], rejectDetail: string): Promise<SubmitResult> => {
    await stores.putJob({ ...job, status: 'REJECTED', rejectedBy, rejectDetail });
    await announceRejection(deps.announce, job, rejectedBy ?? 'unknown', rejectDetail);
    // The owner's own text refused by a safety layer: it counts toward freezing the account (freeze.ts).
    if (rejectedBy === 'prescreen' || rejectedBy === 'guardrail') await noteRefusal(stores, emailId(ownerEmail), deps.now(), { announce: deps.announce, where: 'formulario', text: answers.about });
    return { status: 422 };
  };

  const brand = findBrand(answers.businessName, 'name');
  if (brand) return reject('brand', brand);

  try {
    const screening = await prescreen(answers, deps);
    job.usage.push(screening.usage);
    await countUsage(stores, emailId(ownerEmail), [screening.usage], now);
    job.screening = {
      decision: screening.decision,
      category: screening.category,
      confidence: screening.confidence,
      clarity: screening.clarity,
      offers: screening.offers,
      reason: screening.reason.slice(0, 240),
    };
    if (isRejected(screening)) return reject('prescreen', screening.category);
    if (isUnclear(screening)) {
      // Not abuse: no notice, and the try does not count against the day's limit, so the owner can describe the business again.
      await stores.putJob({ ...job, status: 'REJECTED', rejectedBy: 'unclear' });
      await stores.releaseRateLimit(limit.key).catch(() => undefined);
      return { status: 422, unclear: true };
    }
  } catch (error) {
    if (error instanceof GuardrailBlocked) return reject('guardrail', 'input');
    throw error;
  }

  const slug = await claimSlug(slugify(answers.businessName), job, deps);
  if (!slug) throw new Error('could not claim a slug');
  job.slug = slug;

  await stores.putJob(job);
  await deps.startGenerate(job.jobId);
  return { status: 202, jobId: job.jobId };
}

/** Clean slug first; a random suffix only when it is reserved, blocklisted, or taken. */
async function claimSlug(base: string, job: Job, { stores }: SubmitDeps): Promise<string | undefined> {
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : withSuffix(base);
    if (rejectSlug(slug) || (await stores.isBlocked(slug))) continue;
    if (await stores.claimSlug({ slug, status: 'claimed', jobId: job.jobId, jobIds: [job.jobId], createdAt: job.createdAt })) return slug;
  }
  return undefined;
}
