import { z } from 'zod';
import { cleanContact, type ContactField } from './answers';
import { Contact } from './content';
import { deleteDraft, draftPrefix, loadDraft, mediaPrefix, saveDraft, sourcePrefix } from './drafts';
import { JOB_TTL_SECONDS, type Job, type SiteRecord, type Stores } from './jobs';
import { checkTexts } from './policy';
import { parseToken, secretMatches } from './token';
import type { Urls } from './urls';

const OWNER_REQUESTS_PER_DAY = 60;
/** Free-text edits call the model, so they have their own cap. */
export const EDITS_PER_DAY = 10;

export interface OwnerDeps {
  stores: Stores;
  urls: Urls;
  outputAllowed(text: string): Promise<boolean>;
  startGenerate(jobId: string): Promise<void>;
  now(): number;
  newId(): string;
  newDraftId?: () => string;
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const inTwoDays = (now: number) => Math.floor(now / 1000) + 2 * 86400;

/** `Authorization: Bearer <slug>.<secret>` → the site, or undefined. Also enforces a per-site daily cap. */
export async function authenticate(header: string | undefined, { stores, now }: OwnerDeps): Promise<SiteRecord | 'rate_limited' | undefined> {
  const parsed = parseToken(header?.replace(/^Bearer\s+/i, '') ?? '');
  if (!parsed) return undefined;
  const site = await stores.getSite(parsed.slug);
  if (!site?.tokenHash || !site.tokenExpiresAt || site.tokenExpiresAt < now() / 1000) return undefined;
  if (!secretMatches(parsed.secret, site.tokenHash)) return undefined;
  const allowed = await stores.hitRateLimit(`owner#${site.slug}#${day(now())}`, OWNER_REQUESTS_PER_DAY, inTwoDays(now()));
  return allowed ? site : 'rate_limited';
}

/** What "Mi sitio" shows. Never the token hash. */
export async function ownerView(site: SiteRecord, { stores, urls }: Pick<OwnerDeps, 'stores' | 'urls'>) {
  const doc = site.currentDraftId ? (await loadDraft(site.slug, site.currentDraftId, stores)).doc : undefined;
  return {
    slug: site.slug,
    status: site.status,
    draftUrl: site.currentDraftId ? urls.draftUrl(site.currentDraftId) : undefined,
    canUndo: (site.drafts?.length ?? 0) > 1,
    lang: doc?.answers.lang,
    businessName: doc?.answers.businessName,
    contact: doc?.answers.contact,
  };
}

const ContactInput = z.object(Object.fromEntries(Object.keys(Contact.shape).map((key) => [key, z.string().max(300).optional()])) as Record<ContactField, z.ZodOptional<z.ZodString>>).strict();
const EditBody = z.object({ instruction: z.string().trim().min(3).max(1000).optional(), contact: ContactInput.optional() }).strict();

export type EditResult = { status: 200 } | { status: 202; jobId: string } | { status: 400; fields: string[] } | { status: 409 } | { status: 422 } | { status: 429 };

/**
 * POST /me/edit. Contact changes refill the placeholders at once (a new draft, no model call). An instruction
 * starts an edit job: optional clarify, then edit_site on the current source, the same checks, a new draft.
 */
export async function editSite(site: SiteRecord, body: unknown, deps: OwnerDeps): Promise<EditResult> {
  const { stores } = deps;
  if (!site.currentDraftId) return { status: 409 };
  const parsed = EditBody.safeParse(body ?? {});
  if (!parsed.success) return { status: 400, fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))] };
  const { instruction, contact } = parsed.data;
  if (!instruction && !contact) return { status: 400, fields: ['instruction'] };

  const now = deps.now();
  if (instruction && !(await stores.hitRateLimit(`edits#${site.slug}#${day(now)}`, EDITS_PER_DAY, inTwoDays(now)))) return { status: 429 };

  let current = await loadDraft(site.slug, site.currentDraftId, stores);

  if (contact) {
    const merged: Record<string, string | undefined> = { ...current.doc.answers.contact };
    for (const [field, value] of Object.entries(contact) as [ContactField, string | undefined][]) {
      if (value !== undefined) merged[field] = cleanContact(field, value);
    }
    const checked = Contact.safeParse(merged);
    if (!checked.success) return { status: 400, fields: [...new Set(checked.error.issues.map((i) => `contact.${i.path.join('.')}`))] };
    const address = checked.data.address;
    if (address && address !== current.doc.answers.contact.address && (checkTexts([address]).length > 0 || !(await deps.outputAllowed(address)))) return { status: 422 };
    const doc = { ...current.doc, answers: { ...current.doc.answers, contact: checked.data } };
    await saveDraft(site, current.source, doc, deps);
    site = (await stores.getSite(site.slug)) ?? site;
    current = { ...current, doc };
  }

  if (!instruction) return { status: 200 };

  const source = site.jobId ? await stores.getJob(site.jobId) : undefined;
  const job: Job = {
    jobId: deps.newId(),
    status: 'PENDING',
    kind: 'edit',
    stage: 'clarify',
    createdAt: now,
    startedAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
    ipHash: source?.ipHash ?? 'owner',
    answers: current.doc.answers,
    instruction,
    slug: site.slug,
    usage: [],
  };
  await stores.putJob(job);
  await stores.saveSite({ slug: site.slug, jobIds: [...new Set([...(site.jobIds ?? []), job.jobId])] });
  await deps.startGenerate(job.jobId);
  return { status: 202, jobId: job.jobId };
}

/** "Deshacer": back to the previous version. The newer one is deleted. */
export async function undo(site: SiteRecord, { stores }: Pick<OwnerDeps, 'stores'>): Promise<{ status: 200 } | { status: 409 }> {
  const drafts = site.drafts ?? [];
  if (drafts.length < 2) return { status: 409 };
  const dropped = drafts.at(-1)!;
  await stores.saveSite({ slug: site.slug, drafts: drafts.slice(0, -1), currentDraftId: drafts.at(-2)! });
  await deleteDraft(site.slug, dropped, stores);
  await stores.invalidatePaths([`/${draftPrefix(dropped)}*`]);
  return { status: 200 };
}

/** "Delete my data": every draft, the sources and images, the site record (the slug becomes free), and the text of every job. */
export async function deleteSite(site: SiteRecord, { stores }: Pick<OwnerDeps, 'stores'>): Promise<void> {
  const drafts = site.drafts ?? [];
  for (const draftId of drafts) await deleteDraft(site.slug, draftId, stores);
  await stores.deletePrefix(sourcePrefix(site.slug));
  await stores.deletePrefix(mediaPrefix(site.slug));
  for (const jobId of new Set([site.jobId, ...(site.jobIds ?? [])])) await stores.redactJob(jobId);
  await stores.deleteSite(site.slug);
  if (drafts.length > 0) await stores.invalidatePaths(drafts.map((id) => `/${draftPrefix(id)}*`));
}
