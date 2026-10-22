import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import { createUrls } from '../services/generator/src/core/urls.ts';

// The app's public address (canonical links, link previews, the sitemap), from the CDK context through urls.ts, so
// no domain is written here. A domainless build has none, and those tags are left out.
const context = JSON.parse(readFileSync(new URL('../infra/cdk.json', import.meta.url), 'utf8')).context;
const urls = context.domainName ? createUrls({ mode: 'domain', domainName: context.domainName }) : undefined;
const site = urls?.appUrl;

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
    // The support address on the home page (soporte@<domain>); empty in a domainless build, which has no inbound mail.
    define: { 'import.meta.env.PUBLIC_SUPPORT_EMAIL': JSON.stringify(urls?.supportEmail ?? '') },
    // The form imports the API's zod schema from services/generator.
    server: { fs: { allow: ['..'] } },
  },
  devToolbar: { enabled: false },
});
