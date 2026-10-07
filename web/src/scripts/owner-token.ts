// The owner's token for a site: the magic link, or an account session from "Mis sitios" (`<slug>.<secret>` either
// way). It arrives once in the URL fragment (#token=…). The page keeps it in this browser and leaves only the
// site's name in the address bar (#sitio=<slug>), so the address can be shared, screenshotted, or kept in history
// without handing over the site. If the browser can't keep it (storage blocked), the token stays in the address.

const KEY = 'coyote:owners';
type Saved = Record<string, string>; // slug → token

const slugOf = (token: string) => token.slice(0, Math.max(0, token.indexOf('.')));

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

function save(saved: Saved): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

let current: string | undefined;

/** The token for this page's site: from the address (then kept and removed from it), or kept from before. */
export function ownerToken(): string {
  if (current !== undefined) return current;
  const given = /^#token=(.+)$/.exec(location.hash)?.[1];
  if (given) {
    current = decodeURIComponent(given);
    const slug = slugOf(current);
    if (slug && save({ ...load(), [slug]: current })) history.replaceState(null, '', `${location.pathname}${location.search}#sitio=${encodeURIComponent(slug)}`);
    return current;
  }
  const slug = /^#sitio=(.+)$/.exec(location.hash)?.[1];
  current = (slug && load()[decodeURIComponent(slug)]) || '';
  return current;
}

/** The fragment for links between the owner's pages (Mi sitio, the full-screen preview, the chat). */
export function ownerHash(): string {
  const token = ownerToken();
  // Kept in this browser: the site's name is enough. Otherwise the link has to carry the token.
  return /^#sitio=/.test(location.hash) ? location.hash : token ? `#token=${encodeURIComponent(token)}` : '';
}

/** The link that opens the chat on another device (the QR code): that browser has nothing kept, so it carries the token. */
export const tokenHash = () => `#token=${encodeURIComponent(ownerToken())}`;

/** Forgets the kept tokens: one site's (deleted), or every account session's (signed out of "Mis sitios"). */
export function forgetOwnerTokens(which: { slug: string } | 'sessions') {
  const saved = load();
  for (const [slug, token] of Object.entries(saved)) {
    if (which === 'sessions' ? token.slice(slug.length + 1).startsWith('@') : slug === which.slug) delete saved[slug];
  }
  save(saved);
}
