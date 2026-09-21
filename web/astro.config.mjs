import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
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
