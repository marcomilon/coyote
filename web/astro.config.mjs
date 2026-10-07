import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import { createUrls } from '../services/generator/src/core/urls.ts';

// The app's public address (canonical links, link previews, the sitemap), from the CDK context through urls.ts, so
// no domain is written here. A domainless build has none, and those tags are left out.
const context = JSON.parse(readFileSync(new URL('../infra/cdk.json', import.meta.url), 'utf8')).context;
const site =
  context.domainName && context.sitesDomainName
    ? createUrls({ mode: 'domain', domainName: context.domainName, sitesDomainName: context.sitesDomainName }).appUrl
    : undefined;

export default defineConfig({
  output: 'static',
  site,
  // /crear → /crear/index.html. The app distribution's CloudFront function maps clean URLs to these files.
  build: { format: 'directory' },
  trailingSlash: 'ignore',
  i18n: {
    locales: ['es', 'pt'],
    defaultLocale: 'es',
    routing: { prefixDefaultLocale: false },
  },
  // The app CSP is script-src 'self': every script must be an external file, never inlined.
  vite: {
    build: { assetsInlineLimit: 0 },
    // The form imports the API's zod schema from services/generator.
    server: { fs: { allow: ['..'] } },
  },
  devToolbar: { enabled: false },
});
