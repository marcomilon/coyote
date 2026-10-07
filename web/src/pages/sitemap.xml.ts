// The public pages, in both languages, each with its alternate (hreflang). Each owner's pages are left out.
import type { APIRoute } from 'astro';
import { t } from '../i18n/strings';

type Paths = ReturnType<typeof t>['paths'];
const PUBLIC: (keyof Paths)[] = ['home', 'create', 'terms', 'privacy'];

export const GET: APIRoute = ({ site }) => {
  if (!site) return new Response('', { status: 404 });
  const es = t('es').paths;
  const pt = t('pt').paths;
  const url = (path: string) => new URL(path, site).href;
  const entry = (loc: string, alt: { es: string; pt: string }) =>
    `<url><loc>${loc}</loc><xhtml:link rel="alternate" hreflang="es" href="${alt.es}"/><xhtml:link rel="alternate" hreflang="pt" href="${alt.pt}"/><xhtml:link rel="alternate" hreflang="x-default" href="${alt.es}"/></url>`;
  const urls = PUBLIC.flatMap((key) => {
    const alt = { es: url(es[key]), pt: url(pt[key]) };
    return [entry(alt.es, alt), entry(alt.pt, alt)];
  });
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`,
    { headers: { 'content-type': 'application/xml; charset=utf-8' } },
  );
};
