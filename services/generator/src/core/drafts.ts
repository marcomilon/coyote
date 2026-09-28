import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { THEME_SCRIPTS, THEMES } from '../../themes';
import type { Brief } from './brief';
import { Answers } from './answers';
import { Media, SiteContent } from './content';
import type { SiteRecord, Stores } from './jobs';
import { checkPage } from './page-check';
import { checkHtml } from './policy';
import { render } from './render';
import type { Urls } from './urls';

/**
 * Every version of a site is a draft: `_draft/<draftId>/` holds the rendered page and a copy of its images,
 * served (noindex) only to whoever has the URL. `draftId` is random (128 bits), so the URL is the secret.
 * The record it was rendered from (answers, content, brief, notes) is kept under `_src/<slug>/`, never served:
 * rendering it again makes the same page with no model call (contact edits, a theme or domain change, `refill-all`).
 * A page Opus wrote is kept as written (`page`) and finished (checks, repairs, footer) on every render. Older
 * drafts have no page: their theme content (`content`, `brief`) renders with the theme.
 */

const BriefRecord = z.custom<Brief>((value) => typeof value === 'object' && value !== null && 'theme' in value && 'palette' in value);

export const SiteDoc = z.object({
  /** The form answers (with contact answers merged in), for edits and regenerations. */
  answers: Answers,
  /** The owner's images (uploaded logo and photos), copied into each draft. */
  media: z.custom<Media>((value) => typeof value === 'object' && value !== null && 'photos' in value).optional(),
  /** Themed drafts only (made before the page writer). */
  content: SiteContent.optional(),
  brief: BriefRecord.optional(),
  /** Free-text answers to the model's questions, for later edits. */
  notes: z.array(z.object({ question: z.string().max(200), answer: z.string().max(600) })).max(16),
  /** The page the page writer wrote, before checks. Absent on themed drafts. */
  page: z.string().max(500_000).optional(),
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
}

/** Renders the record (its written page, or its theme) and runs the final checks. A violation here is our bug. */
export function renderDraft(doc: SiteDoc, slug: string, urls: Urls): string {
  if (doc.page !== undefined) {
    const { contact, businessName, lang } = doc.answers;
    const checked = checkPage(doc.page, { contact, ownerText: ownerText(doc), businessName, lang, ...urls.pageLinks(slug, lang) });
    if (checked.violations.length > 0) throw new Error(`written page breaks the page checks: ${JSON.stringify(checked.violations)}`);
    return checked.html;
  }
  if (!doc.content || !doc.brief) throw new Error('draft has neither a page nor theme content');
  const theme = THEMES[doc.brief.theme];
  if (!theme) throw new Error(`unknown theme ${doc.brief.theme}`);
  const page = render({ theme, content: doc.content, brief: doc.brief, siteUrl: urls.siteUrl(slug), ...urls.pageLinks(slug, doc.content.lang) });
  const violations = checkHtml(page, { platformOrigins: [new URL(urls.appUrl).origin, urls.siteOrigin(slug)], whatsapp: doc.content.contact.whatsapp, scripts: THEME_SCRIPTS });
  if (violations.length > 0) throw new Error(`rendered page breaks the HTML policy: ${JSON.stringify(violations)}`);
  return page;
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

  const media = docMedia(doc);
  for (const asset of [media.logo, ...media.photos]) {
    if (asset) await stores.copyObject(`${mediaPrefix(site.slug)}${asset}`, `${prefix}${asset}`, contentType(asset));
  }
  await stores.putPrivate(docKey(site.slug, draftId), JSON.stringify(doc), 'application/json');
  await stores.putPage(`${prefix}index.html`, page);

  const all = [...(site.drafts ?? []), draftId];
  await stores.saveSite({ slug: site.slug, drafts: all.slice(-MAX_DRAFTS), currentDraftId: draftId });
  for (const old of all.slice(0, -MAX_DRAFTS)) await deleteDraft(site.slug, old, stores);
  return draftId;
}

export const docMedia = (doc: SiteDoc): Media => doc.media ?? doc.content?.media ?? { photos: [] };

export async function loadDraft(slug: string, draftId: string, stores: Stores): Promise<SiteDoc> {
  const doc = await stores.getText(docKey(slug, draftId));
  if (doc === undefined) throw new Error(`draft ${draftId} of ${slug} is missing`);
  return SiteDoc.parse(JSON.parse(doc));
}

export async function deleteDraft(slug: string, draftId: string, stores: Stores): Promise<void> {
  await stores.deletePrefix(draftPrefix(draftId));
  await stores.deletePrefix(docKey(slug, draftId));
}

/** Renders the current draft again in place (after a theme, renderer, or domain change). No model call. */
export async function refillDraft(site: SiteRecord, deps: DraftDeps): Promise<boolean> {
  if (!site.currentDraftId) return false;
  const doc = await loadDraft(site.slug, site.currentDraftId, deps.stores);
  await deps.stores.putPage(`${draftPrefix(site.currentDraftId)}index.html`, renderDraft(doc, site.slug, deps.urls));
  return true;
}
