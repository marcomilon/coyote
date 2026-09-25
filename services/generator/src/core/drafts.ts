import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Answers } from './answers';
import { Media } from './content';
import { fillPage } from './fill';
import type { SiteRecord, Stores } from './jobs';
import { checkHtml } from './policy';
import type { Urls } from './urls';

/**
 * Every version of a site is a draft: `_draft/<draftId>/` holds the filled page and a copy of its images,
 * served (noindex) only to whoever has the URL. `draftId` is random (128 bits), so the URL is the secret.
 * The unfilled source and the site record it was filled from are kept under `_src/<slug>/`, never served:
 * filling them again makes the same page with no model call (contact edits, a domain switch, `refill-all`).
 */

export const SiteDoc = z.object({
  /** The form answers. `answers.contact` is the only source of the contact details on the page. */
  answers: Answers,
  /** Free-text answers to the model's questions, for later edits. */
  notes: z.array(z.object({ question: z.string().max(200), answer: z.string().max(600) })).max(16),
  media: Media,
});
export type SiteDoc = z.infer<typeof SiteDoc>;

/** Versions kept per site ("Deshacer" goes back through them). */
export const MAX_DRAFTS = 5;

export const newDraftId = () => randomBytes(16).toString('hex');
export const mediaPrefix = (slug: string) => `_media/${slug}/`;
export const draftPrefix = (draftId: string) => `_draft/${draftId}/`;
export const sourcePrefix = (slug: string) => `_src/${slug}/`;
const sourceKey = (slug: string, draftId: string) => `${sourcePrefix(slug)}${draftId}.html`;
const docKey = (slug: string, draftId: string) => `${sourcePrefix(slug)}${draftId}.json`;

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const contentType = (path: string) => CONTENT_TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream';

export interface DraftDeps {
  stores: Stores;
  urls: Urls;
  newDraftId?: () => string;
}

/** Fills the source and runs the final HTML check. A violation here is our bug, not the owner's. */
export function renderDraft(source: string, doc: SiteDoc, slug: string, urls: Urls): string {
  const page = fillPage(source, doc, slug, urls);
  const violations = checkHtml(page, { platformOrigins: [new URL(urls.appUrl).origin], whatsapp: doc.answers.contact.whatsapp });
  if (violations.length > 0) throw new Error(`filled page breaks the HTML policy: ${JSON.stringify(violations)}`);
  return page;
}

/**
 * Writes a new draft and makes it the site's current version. Older drafts beyond MAX_DRAFTS are deleted.
 * Resolves to the new draft's ID.
 */
export async function saveDraft(site: SiteRecord, source: string, doc: SiteDoc, deps: DraftDeps): Promise<string> {
  const { stores, urls } = deps;
  const page = renderDraft(source, doc, site.slug, urls);
  const draftId = (deps.newDraftId ?? newDraftId)();
  const prefix = draftPrefix(draftId);

  for (const asset of [doc.media.logo, doc.media.hero, ...doc.media.photos]) {
    if (asset) await stores.copyObject(`${mediaPrefix(site.slug)}${asset}`, `${prefix}${asset}`, contentType(asset));
  }
  await stores.putPrivate(sourceKey(site.slug, draftId), source, 'text/html; charset=utf-8');
  await stores.putPrivate(docKey(site.slug, draftId), JSON.stringify(doc), 'application/json');
  await stores.putPage(`${prefix}index.html`, page);

  const all = [...(site.drafts ?? []), draftId];
  const kept = all.slice(-MAX_DRAFTS);
  await stores.saveSite({ slug: site.slug, drafts: kept, currentDraftId: draftId });
  for (const old of all.slice(0, -MAX_DRAFTS)) await deleteDraft(site.slug, old, stores);
  return draftId;
}

export async function loadDraft(slug: string, draftId: string, stores: Stores): Promise<{ source: string; doc: SiteDoc }> {
  const [source, doc] = await Promise.all([stores.getText(sourceKey(slug, draftId)), stores.getText(docKey(slug, draftId))]);
  if (source === undefined || doc === undefined) throw new Error(`draft ${draftId} of ${slug} is missing`);
  return { source, doc: SiteDoc.parse(JSON.parse(doc)) };
}

export async function deleteDraft(slug: string, draftId: string, stores: Stores): Promise<void> {
  await stores.deletePrefix(draftPrefix(draftId));
  await stores.deletePrefix(sourceKey(slug, draftId));
  await stores.deletePrefix(docKey(slug, draftId));
}

/** Fills the current draft again in place (after a renderer or domain change). No model call. */
export async function refillDraft(site: SiteRecord, deps: DraftDeps): Promise<boolean> {
  if (!site.currentDraftId) return false;
  const { source, doc } = await loadDraft(site.slug, site.currentDraftId, deps.stores);
  await deps.stores.putPage(`${draftPrefix(site.currentDraftId)}index.html`, renderDraft(source, doc, site.slug, deps.urls));
  return true;
}
