import { z } from 'zod';
import { normalizeAnswers, type Answers } from './answers';
import { GuardrailBlocked, type CallTool } from './bedrock';
import { findBrand } from './brands';
import { JOB_TTL_SECONDS, type Job, type Stores } from './jobs';
import { isRejected, prescreen } from './prescreen';
import { hashIp, rateLimitKey } from './ratelimit';
import { rejectSlug, slugify, withSuffix } from './slug';

/** The request body. Lengths are capped here so an oversized payload never reaches a model. */
const Body = z.object({
  businessName: z.string().max(200),
  about: z.string().max(2000),
  whatsapp: z.string().max(40),
  address: z.string().max(300).optional(),
  instagram: z.string().max(200).optional(),
  facebook: z.string().max(200).optional(),
  lang: z.string().max(5).optional(),
});

export interface SubmitDeps {
  stores: Stores;
  callTool: CallTool;
  modelId: string;
  rateLimitPerDay: number;
  ipSalt: string;
  /** Starts the generate Lambda asynchronously. */
  startGenerate(jobId: string): Promise<void>;
  now(): number;
  newId(): string;
}

export type SubmitResult =
  | { status: 202; jobId: string }
  | { status: 400; fields: string[] }
  | { status: 422 }
  | { status: 429 };

const SLUG_ATTEMPTS = 5;

/**
 * Order matters: validation and the rate limit cost nothing, so they run before the model call.
 * A rejected request is still recorded (answers, IP hash, reason) for abuse investigation.
 */
export async function submit(body: unknown, ip: string, deps: SubmitDeps): Promise<SubmitResult> {
  const { stores } = deps;

  let answers: Answers;
  try {
    answers = normalizeAnswers(Body.parse(body));
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, fields: [...new Set(error.issues.map((i) => i.path.join('.')))] };
    throw error;
  }

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
    usage: [],
  };
  const reject = async (rejectedBy: Job['rejectedBy'], rejectDetail: string): Promise<SubmitResult> => {
    await stores.putJob({ ...job, status: 'REJECTED', rejectedBy, rejectDetail });
    return { status: 422 };
  };

  const brand = findBrand(answers.businessName, 'name');
  if (brand) return reject('brand', brand);

  try {
    const screening = await prescreen(answers, deps);
    job.usage.push(screening.usage);
    job.screening = {
      decision: screening.decision,
      category: screening.category,
      confidence: screening.confidence,
      reason: screening.reason.slice(0, 240),
    };
    if (isRejected(screening)) return reject('prescreen', screening.category);
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
