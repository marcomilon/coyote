// llms.txt (llmstxt.org): what ventas314.com is, what it costs and its public pages, in plain Markdown for AI assistants.
// Built from the same strings and prices as the pages, so it can't drift from them. It needs the site's address, like
// the sitemap, so a domainless build has none.
import type { APIRoute } from 'astro';
import { t } from '../i18n/strings';
import { countriesFor } from '../config/landing';
import { LOCAL_PRICES, formatPrice } from '../../../services/generator/src/core/prices';

export const GET: APIRoute = ({ site }) => {
  if (!site) return new Response('', { status: 404 });
  const es = t('es');
  const pt = t('pt');
  const url = (path: string) => new URL(path, site).href;
  const countries = countriesFor('es');
  const local = countries.filter((c) => c.code in LOCAL_PRICES);
  const row = (name: string, code: string, lang: 'es' | 'pt' = 'es') => `| ${name} | ${formatPrice('plan', code, lang)} | ${formatPrice('designs', code, lang)} |`;
  const text = [
    '# ventas314.com',
    '',
    '> ventas314.com designs a website for a small business in Latin America from a few questions, in Spanish or Portuguese, with WhatsApp and call buttons. Making the site is free; publishing it on the business\'s own domain is a monthly plan.',
    '',
    '## How it works',
    '',
    '- The owner answers a few questions on a web form: the business name, what it does, and how customers reach it. If something is missing, we ask.',
    '- The page is designed in a few minutes. The owner asks for changes in their own words, in a chat.',
    '- The first 3 designs are free, with no card. More designs come in packs of 3.',
    `- Publishing is the monthly plan: the site goes live on the business's own domain (.com), which we register. No contract; it can be cancelled any time.`,
    '',
    '## Prices',
    '',
    'Prices include tax. These countries pay in their own currency; every other country pays in US dollars.',
    '',
    '| Country | Monthly plan | 3 more designs (one-time) |',
    '| --- | --- | --- |',
    ...local.map((c) => row(c.name.es, c.code, c.code === 'BR' ? 'pt' : 'es')),
    row('Other countries', ''),
    '',
    `Countries served: ${countries.map((c) => c.name.es).join(', ')}.`,
    '',
    '## Pages',
    '',
    `- [Home, Spanish](${url(es.paths.home)}): what it is, examples, prices and FAQ`,
    `- [Home, Portuguese](${url(pt.paths.home)}): the same, for Brazil`,
    `- [Create a website](${url(es.paths.create)}) ([Portuguese](${url(pt.paths.create)})): the form`,
    `- [About](${url(es.paths.about)}) ([Portuguese](${url(pt.paths.about)})): who runs it, payments, refunds and data`,
    `- [Terms of use](${url(es.paths.terms)}) ([Portuguese](${url(pt.paths.terms)}))`,
    `- [Privacy](${url(es.paths.privacy)}) ([Portuguese](${url(pt.paths.privacy)}))`,
    `- [Refunds](${url(es.paths.refunds)}) ([Portuguese](${url(pt.paths.refunds)}))`,
    '',
  ];
  return new Response(text.join('\n'), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
};
