// robots.txt: the public pages are open; each owner's pages are not (they are noindex too). The sitemap needs the
// site's address, so a domainless build lists none.
import type { APIRoute } from 'astro';
import { t } from '../i18n/strings';

const PRIVATE = (['es', 'pt'] as const).flatMap((lang) => {
  const p = t(lang).paths;
  return [p.mySite, p.mySites, p.chat, p.preview];
});

export const GET: APIRoute = ({ site }) =>
  new Response(
    ['User-agent: *', 'Allow: /', ...PRIVATE.map((path) => `Disallow: ${path}`), ...(site ? ['', `Sitemap: ${new URL('/sitemap.xml', site).href}`] : [])].join('\n') + '\n',
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
