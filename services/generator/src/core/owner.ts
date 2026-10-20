import { voiceOf } from './i18n';
import { z } from 'zod';
import { checkSession } from './account';
import { noteDesignChosen, noteRedesign, noteUndo } from './chat-notes';
import { cleanContact, type ContactField } from './answers';
import { Contact } from './content';
import { deleteDraft, draftPrefix, keptDrafts, loadDraft, mediaPrefix, ownerText, refreshPreview, saveDraft, sourcePrefix, type SiteDoc } from './drafts';
import { JOB_TTL_SECONDS, publicJob, type Job, type SiteRecord, type Stores } from './jobs';
import type { ModelTier } from './models';
import { paidWritesLeft } from './paid-writes';
import { isFrozen } from './freeze';
import { checkPage, contactMissing, replaceContact } from './page-check';
import { editTexts, ownerTextsAfter, pageTexts, type TextEdit } from './page-texts';
import { checkTexts } from './policy';
import { parseToken, secretMatches } from './token';
import { onlyLogo } from './uploads';
import { hasLogoSpot } from './logo';
import { changePhotosInPlace } from './photo-slots';
import type { Urls } from './urls';

const OWNER_REQUESTS_PER_DAY = 60;
/** Chat messages searched for the reply that made an undone draft (only the last few drafts are kept). */
const UNDO_LOOKBACK = 100;

export interface OwnerDeps {
  stores: Stores;
  urls: Urls;
  outputAllowed(text: string): Promise<boolean>;
  startGenerate(jobId: string): Promise<void>;
  /** Invokes the chat Lambda for a Coyote reply that is waiting (chat.ts). */
  startChat(slug: string, at: number): Promise<void>;
  /** The tier of the model the next page write would use (models.ts). Undefined: paid. */
  pageTier?(): Promise<ModelTier>;
  now(): number;
  newId(): string;
  newDraftId?: () => string;
}

export const day = (now: number) => new Date(now).toISOString().slice(0, 10);
export const inTwoDays = (now: number) => Math.floor(now / 1000) + 2 * 86400;

/** The chat and the result page poll GET /me/chat every few seconds: a cap of its own, far above the owner's. */
export const POLL_CAP = { name: 'poll', max: 3000 };
/** GET /me (Mi sitio, /ver, the reload after a change) only reads: a cap of its own, so looking never uses up changes. */
export const READ_CAP = { name: 'read', max: 1000 };

/**
 * `Authorization: Bearer <slug>.<secret>` → the site, or undefined. The secret is the site's magic link, or a
 * "Mis sitios" session (`@<id>.<secret>`) of the account the site belongs to. Also enforces a per-site daily cap.
 */
export async function authenticate(
  header: string | undefined,
  { stores, now }: Pick<OwnerDeps, 'stores' | 'now'>,
  cap = { name: 'owner', max: OWNER_REQUESTS_PER_DAY },
): Promise<SiteRecord | 'rate_limited' | undefined> {
  const parsed = parseToken(header?.replace(/^Bearer\s+/i, '') ?? '');
  if (!parsed) return undefined;
  const site = await stores.getSite(parsed.slug);
  if (!site) return undefined;
  if (parsed.secret.startsWith('@')) {
    if (!site.ownerEmailId || (await checkSession(parsed.secret, { stores, now })) !== site.ownerEmailId) return undefined;
  } else {
    if (!site.tokenHash || !site.tokenExpiresAt || site.tokenExpiresAt < now() / 1000) return undefined;
    if (!secretMatches(parsed.secret, site.tokenHash)) return undefined;
  }
  const allowed = await stores.hitRateLimit(`${cap.name}#${site.slug}#${day(now())}`, cap.max, inTwoDays(now()));
  return allowed ? site : 'rate_limited';
}

/** The stable URL that always shows the current draft (made with the first draft; refill-all makes any missing one). */
export const previewUrl = (site: SiteRecord, urls: Urls) => (site.previewId ? urls.draftUrl(site.previewId) : undefined);

/** What "Mi sitio" shows. Never the token hash. */
/** Paid-tier page writes the site's owner has left; undefined when page writes are free-tier now (no limit). */
export async function designsLeft(site: SiteRecord, deps: Pick<OwnerDeps, 'stores' | 'pageTier'>): Promise<number | undefined> {
  if (!site.ownerEmailId || (await deps.pageTier?.()) === 'free') return undefined;
  return paidWritesLeft(deps.stores, site.ownerEmailId);
}

export async function ownerView(site: SiteRecord, deps: Pick<OwnerDeps, 'stores' | 'urls' | 'pageTier'>) {
  const { stores, urls } = deps;
  const doc = site.currentDraftId ? await loadDraft(site.slug, site.currentDraftId, stores) : undefined;
  return {
    // 0: no redesigns left; Mi sitio shows a banner and its redesign buttons get 402.
    designsLeft: await designsLeft(site, deps),
    // Too many refused requests (freeze.ts): Mi sitio shows a banner, and every change answers 423.
    frozen: await isFrozen(stores, site.ownerEmailId),
    // Mi sitio → Diseños: every design, oldest first; `current` is the one the site uses.
    designs: (site.designs ?? []).map(({ id, draftId, at, kind, request }) => ({ id, at, kind, ...(request && { request }), draftUrl: urls.draftUrl(draftId), current: draftId === site.currentDraftId })),
    slug: site.slug,
    status: site.status,
    draftUrl: site.currentDraftId ? urls.draftUrl(site.currentDraftId) : undefined,
    previewUrl: previewUrl(site, urls),
    canUndo: (site.drafts?.length ?? 0) > 1,
    lang: doc?.answers.lang,
    businessName: doc?.answers.businessName,
    contact: doc?.answers.contact,
    // The logo and the owner's photos, from the current draft (Mi sitio → Fotos).
    images: doc && site.currentDraftId ? siteImages(doc, urls.draftUrl(site.currentDraftId)) : undefined,
    // The photos the page writer made that the page shows (Tus fotos: the owner can put their own in their place).
    made: doc && site.currentDraftId ? (doc.media.generated ?? []).filter((file) => doc.page.includes(file)).map((file) => ({ file, url: urls.draftUrl(site.currentDraftId!) + file })) : undefined,
    // Every text on the page, for Mi sitio → Tus textos.
    texts: doc ? pageTexts(doc.page, doc.answers.contact) : undefined,
  };
}

const siteImages = ({ media }: SiteDoc, base: string) => ({
  logo: media.logo && { file: media.logo, url: base + media.logo },
  photos: media.photos.map((file) => ({ file, url: base + file, caption: media.captions?.[file] })),
});

const ContactInput = z.object(Object.fromEntries(Object.keys(Contact.shape).map((key) => [key, z.string().max(300).optional()])) as Record<ContactField, z.ZodOptional<z.ZodString>>).strict();
const EditBody = z
  .object({
    instruction: z.string().trim().min(3).max(1000).optional(),
    contact: ContactInput.optional(),
    /** Texts changed in Mi sitio → Tus textos: each entry's place, the text it had, and the new text. */
    texts: z.array(z.object({ id: z.number().int().min(0), from: z.string().max(5000), to: z.string().trim().min(1).max(5000) }).strict()).min(1).max(300).optional(),
    /** Photos added in Mi sitio (POST /uploads), and the site's images to take out. */
    uploadId: z.string().uuid().optional(),
    removePhotos: z.array(z.string().max(100)).max(7).optional(),
    /** New descriptions of the site's photos, by file ("" clears one); what the added photos show, in upload order. */
    captions: z.record(z.string().max(100), z.string().trim().max(100)).optional(),
    newCaptions: z.array(z.string().trim().max(100)).max(6).optional(),
    /** Made photos the uploaded photos replace, in upload order: a swap in the page, no redesign. */
    replaceMade: z.array(z.string().max(100)).min(1).max(6).optional(),
    /** The chat reply whose "Rediseñar" button started this edit (its `at`). */
    from: z.number().int().positive().optional(),
  })
  .strict();

export type EditResult =
  | { status: 200; missing: string[] }
  | { status: 202; jobId: string }
  | { status: 400; fields: string[] }
  /** The owner's email used up its paid writes (paid-writes.ts). */
  | { status: 402 }
  /** The owner's account is frozen (freeze.ts). */
  | { status: 423 }
  | { status: 409; error?: 'busy' | 'stale' }
  | { status: 422 }
  | { status: 429 };

/** The page writer is changing this site: its last edit job is still running or waiting for the owner's answers. */
export async function runningEdit(site: SiteRecord, stores: Pick<Stores, 'getJob'>, now: number): Promise<string | undefined> {
  const last = site.jobIds?.at(-1);
  const job = last ? await stores.getJob(last) : undefined;
  return job?.kind === 'edit' && ['PENDING', 'NEEDS_INPUT'].includes(publicJob(job, now).status) ? job.jobId : undefined;
}

/**
 * POST /me/edit. Contact changes refill the placeholders at once (a new draft, no model call). An instruction
 * starts an edit job: optional clarify, then the page writer on the current page, the same checks, a new draft.
 */
export async function editSite(site: SiteRecord, body: unknown, deps: OwnerDeps): Promise<EditResult> {
  const { stores } = deps;
  if (!site.currentDraftId) return { status: 409 };
  const parsed = EditBody.safeParse(body ?? {});
  if (!parsed.success) return { status: 400, fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))] };
  const { instruction, contact, texts, from, uploadId, replaceMade } = parsed.data;
  if (await isFrozen(stores, site.ownerEmailId)) return { status: 423 };
  // A swap: only photos in place of made ones, nothing else.
  if (replaceMade && (!uploadId || instruction || parsed.data.removePhotos?.length || parsed.data.captions)) return { status: 400, fields: ['replaceMade'] };
  const removePhotos = parsed.data.removePhotos?.length ? parsed.data.removePhotos : undefined;
  const captions = parsed.data.captions && Object.keys(parsed.data.captions).length > 0 ? parsed.data.captions : undefined;
  const newCaptions = uploadId && parsed.data.newCaptions?.some(Boolean) ? parsed.data.newCaptions : undefined;
  // A redesign: a change request, or photos added, taken out, or described.
  const redesign = Boolean(instruction || uploadId || removePhotos || captions);
  if (!redesign && !contact && !texts) return { status: 400, fields: ['instruction'] };

  const now = deps.now();
  // One redesign at a time: a second one would start from the page the first is about to replace. The same for
  // texts: the redesign would drop them.
  if ((redesign || texts) && (await runningEdit(site, stores, now))) return { status: 409, error: 'busy' };

  let current = await loadDraft(site.slug, site.currentDraftId, stores);
  const images = [current.media.logo, ...current.media.photos];
  if (removePhotos?.some((file) => !images.includes(file))) return { status: 400, fields: ['removePhotos'] };
  if (captions && Object.keys(captions).some((file) => !current.media.photos.includes(file))) return { status: 400, fields: ['captions'] };
  if (replaceMade?.some((file) => !current.media.generated?.includes(file) || !current.page.includes(file))) return { status: 400, fields: ['replaceMade'] };
  // Only a new logo, and the page shows the old one or has a tagged logo spot (logo.ts): put in with no page writer, like replaceMade.
  const oldLogo = current.media.logo;
  const logoGoes = (oldLogo && current.page.includes(oldLogo)) || hasLogoSpot(current.page);
  const swapLogo = Boolean(uploadId && !instruction && !captions && !newCaptions && !replaceMade && logoGoes && !removePhotos?.some((file) => file !== oldLogo) && (await onlyLogo(uploadId, stores)));
  // Photos taken out, described, or added where the page has a place for them: changed in place (photo-slots.ts).
  // A new upload's files aren't known yet: a stand-in checks there is a place, and a logo among them goes to the page writer.
  const logos = [current.media.logo];
  const inPlace =
    !instruction && !replaceMade && !swapLogo && !removePhotos?.some((file) => logos.includes(file)) &&
    changePhotosInPlace(current.page, { added: uploadId ? ['assets/new-photo'] : [], removed: removePhotos ?? [], described: Object.keys(captions ?? {}) }, current.media.photos, { ...current.media.captions, ...captions }) !== undefined;
  const swap = Boolean(replaceMade) || swapLogo || inPlace;
  // A paid-tier redesign needs one of the email's paid writes left (the claim itself is in the generate job); that is
  // its only limit. A swap calls no model, so it needs none.
  if (redesign && !swap && (await designsLeft(site, deps)) === 0) return { status: 402 };

  let missing: string[] = [];
  if (texts) {
    const changed = await applyTexts(current, texts, deps);
    if ('status' in changed) return changed;
    if (changed.doc.page !== current.page) {
      await saveDraft(site, changed.doc, deps);
      site = (await stores.getSite(site.slug)) ?? site;
      current = changed.doc;
    }
  }
  if (contact) {
    const changed = await applyContact(current, contact, deps);
    if ('status' in changed) return changed;
    await saveDraft(site, changed.doc, deps);
    site = (await stores.getSite(site.slug)) ?? site;
    current = changed.doc;
    missing = changed.missing;
  }

  if (!redesign) return { status: 200, missing };

  const source = site.jobId ? await stores.getJob(site.jobId) : undefined;
  const jobId = deps.newId();
  const job: Job = {
    jobId,
    status: 'PENDING',
    kind: 'edit',
    stage: 'clarify',
    createdAt: now,
    startedAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
    ipHash: source?.ipHash ?? 'owner',
    answers: current.answers,
    ...(instruction && { instruction }),
    ...(uploadId && { uploadId }),
    ...(removePhotos && { removePhotos }),
    ...(captions && { captions }),
    ...(newCaptions && { newCaptions }),
    ...(replaceMade && { replaceMade }),
    ...(swapLogo && { swapLogo: true }),
    slug: site.slug,
    usage: [],
    chatAt: await noteRedesign(stores, site.slug, jobId, voiceOf(current.answers), now),
  };
  await stores.putJob(job);
  await stores.saveSite({ slug: site.slug, jobIds: [...new Set([...(site.jobIds ?? []), job.jobId])] });
  await deps.startGenerate(job.jobId);
  // Spends the chat's button. A stale or unknown `from` only leaves the button there.
  if (from) await stores.updateChat(site.slug, from, { redesignStarted: true }).catch(() => undefined);
  return { status: 202, jobId: job.jobId };
}

export type ContactInput = z.infer<typeof ContactInput>;

/**
 * A contact change, with no model call: the new details are swapped into the page.
 * Resolves to the changed record, not saved yet.
 */
export async function applyContact(
  current: SiteDoc,
  contact: ContactInput,
  deps: Pick<OwnerDeps, 'outputAllowed'>,
): Promise<{ doc: SiteDoc; missing: (keyof Contact)[] } | { status: 400; fields: string[] } | { status: 422 }> {
  const merged: Record<string, string | undefined> = { ...current.answers.contact };
  for (const [field, value] of Object.entries(contact) as [ContactField, string | undefined][]) {
    if (value !== undefined) merged[field] = cleanContact(field, value);
  }
  const checked = Contact.safeParse(merged);
  if (!checked.success) return { status: 400, fields: [...new Set(checked.error.issues.map((i) => `contact.${i.path.join('.')}`))] };
  const address = checked.data.address;
  if (address && address !== current.answers.contact.address && (checkTexts([address]).length > 0 || !(await deps.outputAllowed(address)))) return { status: 422 };
  const page = replaceContact(current.page, current.answers.contact, checked.data);
  const doc = { ...current, answers: { ...current.answers, contact: checked.data }, page };
  // A detail removed from the page can still be in its text; that change needs an edit request.
  if (checkPage(page, { contact: checked.data, ownerText: ownerText(doc), businessName: doc.answers.businessName, lang: doc.answers.lang }).violations.length > 0) return { status: 422 };
  // Saved either way; the owner is told when the page still shows the old detail (it can be changed in the chat).
  return { doc, missing: contactMissing(page, current.answers.contact, checked.data) };
}

const PHONE_OR_EMAIL = /\d[\d\s().-]{5,}\d|@/;

/**
 * Texts the owner wrote in Tus textos, with no model call: each one replaces the old text where it stands. The
 * page checks and the output guardrail run on the result. Resolves to the changed record, not saved yet.
 */
export async function applyTexts(
  current: SiteDoc,
  edits: TextEdit[],
  deps: Pick<OwnerDeps, 'outputAllowed'>,
): Promise<{ doc: SiteDoc } | { status: 400; fields: string[] } | { status: 409; error: 'stale' } | { status: 422 }> {
  const edited = editTexts(current.page, edits, current.answers.contact);
  if ('problem' in edited) return edited.problem === 'stale' ? { status: 409, error: 'stale' } : { status: 400, fields: ['texts'] };
  if (edited.page === current.page) return { doc: current };
  // Numbers and emails the owner typed are theirs, as in a chat request.
  const typed = edits.map((e) => e.to).filter((text) => PHONE_OR_EMAIL.test(text)).join('\n').slice(0, 1000);
  const ownerTexts = ownerTextsAfter(current.page, edited.page, current.answers.contact, current.ownerTexts);
  const doc: SiteDoc = { ...current, page: edited.page, ownerTexts, ...(typed && { requests: [...(current.requests ?? []), typed] }) };
  const { contact, businessName, lang } = doc.answers;
  const options = { contact, businessName, lang };
  const checked = checkPage(doc.page, { ...options, ownerText: ownerText(doc) });
  if (checked.violations.length > 0) return { status: 422 };
  const before = new Set(checkPage(current.page, { ...options, ownerText: ownerText(current) }).texts);
  const added = checked.texts.filter((text) => !before.has(text));
  if (added.length > 0 && !(await deps.outputAllowed(added.join('\n')))) return { status: 422 };
  return { doc };
}

/**
 * Mi sitio → Diseños: the site uses another of its designs. Its latest version is saved again as a new version of
 * that design, so the versions stay in order and "Deshacer" goes back to the design shown before. No model call.
 */
export async function chooseDesign(site: SiteRecord, body: unknown, deps: OwnerDeps): Promise<{ status: 200 } | { status: 400 | 404 | 423 } | { status: 409; error: 'busy' }> {
  if (await isFrozen(deps.stores, site.ownerEmailId)) return { status: 423 };
  const parsed = z.object({ design: z.string().max(64) }).strict().safeParse(body ?? {});
  if (!parsed.success) return { status: 400 };
  const design = site.designs?.find((d) => d.id === parsed.data.design);
  if (!design) return { status: 404 };
  if (design.draftId === site.currentDraftId) return { status: 200 };
  const now = deps.now();
  if (await runningEdit(site, deps.stores, now)) return { status: 409, error: 'busy' };
  const doc = await loadDraft(site.slug, design.draftId, deps.stores);
  const draftId = await saveDraft(site, doc, deps);
  await noteDesignChosen(deps.stores, site.slug, voiceOf(doc.answers), now, draftId);
  return { status: 200 };
}

/** "Deshacer": back to the previous version. The newer one is deleted. */
export async function undo(site: SiteRecord, { stores, now }: Pick<OwnerDeps, 'stores' | 'now'>): Promise<{ status: 200 } | { status: 409 }> {
  const drafts = site.drafts ?? [];
  if (drafts.length < 2) return { status: 409 };
  const dropped = drafts.at(-1)!;
  const previous = drafts.at(-2)!;
  // The design the dropped version belonged to goes back to its version before, or goes with it when it started there.
  const back = await loadDraft(site.slug, previous, stores);
  const designs = (site.designs ?? []).flatMap((d) => (d.draftId !== dropped ? [d] : d.id !== dropped && back.design === d.id ? [{ ...d, draftId: previous }] : d.id !== dropped ? [d] : []));
  await stores.saveSite({ slug: site.slug, drafts: drafts.slice(0, -1), currentDraftId: previous, designs });
  await refreshPreview(site.slug, previous, { stores });
  if (!designs.some((d) => d.draftId === dropped)) await deleteDraft(site.slug, dropped, stores);
  await stores.invalidatePaths([`/${draftPrefix(dropped)}*`]);
  // The chat reply that made it says so, so the chat model is not told the change is still there.
  const made = (await stores.listChat(site.slug, 0, UNDO_LOOKBACK)).find((m) => m.draftId === dropped);
  if (made) await stores.updateChat(site.slug, made.at, { undone: true });
  await noteUndo(stores, site.slug, voiceOf(back.answers), now());
  return { status: 200 };
}

/** "Delete my data": every draft, the sources and images, the site record (the slug becomes free), and the text of every job. */
export async function deleteSite(site: SiteRecord, { stores }: Pick<OwnerDeps, 'stores'>): Promise<void> {
  const drafts = keptDrafts(site);
  const previews = site.previewId ? [site.previewId] : [];
  for (const draftId of [...drafts, ...previews]) await deleteDraft(site.slug, draftId, stores);
  await stores.deletePrefix(sourcePrefix(site.slug));
  await stores.deletePrefix(mediaPrefix(site.slug));
  await stores.deleteChat(site.slug);
  if (site.ownerEmailId) await stores.unlinkAccountSite(site.ownerEmailId, site.slug);
  for (const jobId of new Set([site.jobId, ...(site.jobIds ?? [])])) await stores.redactJob(jobId);
  await stores.deleteSite(site.slug);
  if (drafts.length + previews.length > 0) await stores.invalidatePaths([...drafts, ...previews].map((id) => `/${draftPrefix(id)}*`));
}
