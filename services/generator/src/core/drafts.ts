import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Answers } from './answers';
import { Media } from './content';
import type { SiteRecord, Stores } from './jobs';
import { checkPage } from './page-check';
import type { Urls } from './urls';

/**
 * Every version of a site is a draft: `_draft/<draftId>/` holds the rendered page and a copy of its images,
 * served (noindex) only to whoever has the URL. `draftId` is random (128 bits), so the URL is the secret.
 * The record it was rendered from (answers, notes, the written page) is kept under `_src/<slug>/`, never served:
 * rendering it again makes the same page with no model call (contact edits, a domain change, `refill-all`).
 * The last few drafts are kept for "Deshacer"; `currentDraftId` points at the one shown. The site's preview
 * (`_draft/<previewId>/`) follows that pointer: a stable URL that always shows the current draft.
 * The page Opus wrote is kept as written (`page`) and finished (checks, repairs, footer) on every render.
 */

export const SiteDoc = z.object({
  /** The form answers (with contact answers merged in), for edits and regenerations. */
  answers: Answers,
  /** The owner's images (uploaded logo and photos), copied into each draft. */
  media: Media.default({ photos: [] }),
  /** Free-text answers to the model's questions, for later edits. */
  notes: z.array(z.object({ question: z.string().max(200), answer: z.string().max(600) })).max(16),
  /** The page the page writer wrote, before checks. */
  page: z.string().max(500_000),
  /** The owner's edit requests on the written page, so the numbers and emails they gave stay allowed. */
  requests: z.array(z.string().max(1000)).optional(),
});
export type SiteDoc = z.infer<typeof SiteDoc>;

/** Everything the owner wrote besides the contact answers: its phone numbers and emails may appear on the page. */
export const ownerText = ({ answers, notes, requests }: Pick<SiteDoc, 'answers' | 'notes' | 'requests'>) =>
  [answers.about, ...notes.map((n) => n.answer), ...(requests ?? [])].join('\n');

/** Versions kept per site ("Deshacer" goes back through them). */
export const MAX_DRAFTS = 5;

export const newDraftId = () => randomBytes(16).toString('hex');
export const mediaPrefix = (slug: string) => `_media/${slug}/`;
export const draftPrefix = (draftId: string) => `_draft/${draftId}/`;
export const sourcePrefix = (slug: string) => `_src/${slug}/`;
const docKey = (slug: string, draftId: string) => `${sourcePrefix(slug)}${draftId}.json`;

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const contentType = (path: string) => CONTENT_TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream';

export interface DraftDeps {
  stores: Stores;
  urls: Urls;
  newDraftId?: () => string;
  newPreviewId?: () => string;
}

/**
 * Copies the draft `currentDraftId` points at to the site's preview, creating the preview on first use. The page
 * is served with no-cache, so a reload always shows the current version. Call it whenever the pointer moves.
 */
export async function refreshPreview(slug: string, draftId: string, deps: Pick<DraftDeps, 'stores' | 'newPreviewId'>): Promise<string> {
  const { stores } = deps;
  const site = await stores.getSite(slug);
  const previewId = site?.previewId ?? (deps.newPreviewId ?? newDraftId)();
  const from = draftPrefix(draftId);
  const to = draftPrefix(previewId);
  const page = await stores.getText(`${from}index.html`);
  if (page === undefined) throw new Error(`draft ${draftId} of ${slug} has no page`);
  for (const key of await stores.listKeys(from)) {
    if (key !== `${from}index.html`) await stores.copyObject(key, `${to}${key.slice(from.length)}`, contentType(key));
  }
  await stores.putPage(`${to}index.html`, page, 'no-cache');
  if (!site?.previewId) await stores.saveSite({ slug, previewId });
  return previewId;
}

/** Finishes the written page (checks, repairs, footer). A violation here is our bug. */
export function renderDraft(doc: SiteDoc, slug: string, urls: Urls): string {
  const { contact, businessName, lang } = doc.answers;
  const checked = checkPage(doc.page, { contact, ownerText: ownerText(doc), businessName, lang, ...urls.pageLinks(slug, lang) });
  if (checked.violations.length > 0) throw new Error(`written page breaks the page checks: ${JSON.stringify(checked.violations)}`);
  return checked.html;
}

/**
 * Writes a new draft and makes it the site's current version. Older drafts beyond MAX_DRAFTS are deleted.
 * Resolves to the new draft's ID.
 */
export async function saveDraft(site: SiteRecord, doc: SiteDoc, deps: DraftDeps): Promise<string> {
  const { stores, urls } = deps;
  const page = renderDraft(doc, site.slug, urls);
  const draftId = (deps.newDraftId ?? newDraftId)();
  const prefix = draftPrefix(draftId);

  for (const asset of [doc.media.logo, ...doc.media.photos, ...(doc.media.generated ?? [])]) {
    if (asset) await stores.copyObject(`${mediaPrefix(site.slug)}${asset}`, `${prefix}${asset}`, contentType(asset));
  }
  await stores.putPrivate(docKey(site.slug, draftId), JSON.stringify(doc), 'application/json');
  await stores.putPage(`${prefix}index.html`, page);

  const all = [...(site.drafts ?? []), draftId];
  await stores.saveSite({ slug: site.slug, drafts: all.slice(-MAX_DRAFTS), currentDraftId: draftId });
  for (const old of all.slice(0, -MAX_DRAFTS)) await deleteDraft(site.slug, old, stores);
  await refreshPreview(site.slug, draftId, deps);
  return draftId;
}

export async function loadDraft(slug: string, draftId: string, stores: Stores): Promise<SiteDoc> {
  const doc = await stores.getText(docKey(slug, draftId));
  if (doc === undefined) throw new Error(`draft ${draftId} of ${slug} is missing`);
  return SiteDoc.parse(JSON.parse(doc));
}

export async function deleteDraft(slug: string, draftId: string, stores: Stores): Promise<void> {
  await stores.deletePrefix(draftPrefix(draftId));
  await stores.deletePrefix(docKey(slug, draftId));
}

/** Finishes the current draft again in place (after a page-check or domain change). No model call. */
export async function refillDraft(site: SiteRecord, deps: DraftDeps): Promise<boolean> {
  if (!site.currentDraftId) return false;
  const doc = await loadDraft(site.slug, site.currentDraftId, deps.stores);
  await deps.stores.putPage(`${draftPrefix(site.currentDraftId)}index.html`, renderDraft(doc, site.slug, deps.urls));
  await refreshPreview(site.slug, site.currentDraftId, deps);
  return true;
}
