/**
 * Makes a page from an opus:sites run one of the landing page's example sites (PLAN.md "Landing examples").
 *   ./coyote.sh example-page <run>/pages/<biz>/<page-dir> <slug>
 * Copies index.html and the photos it uses to examples/sites/<slug>/, with the footer's placeholder links
 * (https://app.example/...) swapped for the stack's real ones. `./coyote.sh deploy` publishes it.
 * The URLs come from infra/cdk.json's domainName, else the env vars of urlConfigFromEnv.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_SITES } from '../src/core/examples';
import { createUrls, urlConfigFromEnv } from '../src/core/urls';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [source, slug] = process.argv.slice(2);
if (!source || !slug) throw new Error('usage: example-page <page-dir> <slug>');
if (!(EXAMPLE_SITES as readonly string[]).includes(slug)) throw new Error(`${slug} is not in EXAMPLE_SITES (src/core/examples.ts): ${EXAMPLE_SITES.join(', ')}`);
const page = resolve(source, 'index.html');
if (!existsSync(page)) throw new Error(`${page} does not exist (a page made with --images on is <dir>/index.html)`);

const { domainName } = JSON.parse(readFileSync(resolve(repo, 'infra/cdk.json'), 'utf8')).context ?? {};
const urls = createUrls(domainName ? { mode: 'domain', domainName } : urlConfigFromEnv(process.env));

let html = readFileSync(page, 'utf8');
const lang = /<html[^>]*\blang="pt/i.test(html) ? 'pt' : 'es';
const links = urls.pageLinks(slug, lang);
const placeholders: [string, string][] = [
  ['https://app.example/reportar', links.reportUrl],
  ['https://app.example/privacidad', links.privacyUrl],
  ['https://app.example/', links.homeUrl],
];
for (const [from, to] of placeholders) html = html.split(`"${from}"`).join(`"${to}"`);
if (html.includes('app.example')) throw new Error('the page still links to app.example: was it made by opus:sites?');

const out = resolve(repo, 'examples/sites', slug);
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'assets'), { recursive: true });
const assets = [...new Set(html.match(/assets\/[\w.-]+/g) ?? [])];
for (const file of assets) copyFileSync(resolve(source, file), resolve(out, file));
writeFileSync(resolve(out, 'index.html'), html);
console.log(`${out}/index.html (${assets.length} photos) → ${urls.exampleUrl(slug)} after ./coyote.sh deploy`);
