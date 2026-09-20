import type { Brief } from './brief';
import type { SiteContent } from './content';
import { sanitizeSignatureCss } from './css';
import { FONT_PAIRINGS, googleFontsUrl, type FontPairingId } from './fonts';
import { html, raw } from './html';
import { strings } from './i18n';
import type { SiteLinks, Theme } from './theme';

export interface RenderInput {
  theme: Theme;
  content: SiteContent;
  brief: Brief;
  /** Canonical URL of the page (from urls.ts). */
  siteUrl: string;
  reportUrl: string;
  privacyUrl: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);line-height:1.55}
h1,h2,h3{font-family:var(--font-display);line-height:1.1;margin:0}
img{max-width:100%;display:block}
a{color:inherit}
.coyote-footer{padding:1.5rem 1.25rem;font-size:.8rem;opacity:.7;text-align:center}
.coyote-footer a{margin-left:.5rem}
`;

export function buildLinks(content: SiteContent): SiteLinks {
  const { contact, location, lang } = content;
  const greeting = encodeURIComponent(strings(lang).whatsappGreeting);
  const place = [contact.address, location.neighborhood, location.city].filter(Boolean).join(', ');
  return {
    whatsapp: `https://wa.me/${contact.whatsapp}?text=${greeting}`,
    instagram: contact.instagram ? `https://instagram.com/${contact.instagram}` : undefined,
    facebook: contact.facebook ? `https://facebook.com/${contact.facebook}` : undefined,
    maps: contact.address ? `https://maps.google.com/?q=${encodeURIComponent(place)}` : undefined,
  };
}

/** Pure function of the stored record: same input, same page. No model call. */
export function render(input: RenderInput): string {
  const { theme, content, brief, siteUrl, reportUrl, privacyUrl } = input;
  const t = strings(content.lang);

  const { ink, paper, accent } = brief.palette;
  if (![ink, paper, accent].every((c) => HEX.test(c))) throw new Error('palette must be hex colors');
  const fonts = FONT_PAIRINGS[brief.fontPairing as FontPairingId];
  if (!fonts) throw new Error(`unknown font pairing: ${brief.fontPairing}`);

  const tokens = `:root{--ink:${ink};--paper:${paper};--accent:${accent};--font-display:${fonts.display};--font-body:${fonts.body}}`;
  const signature = content.signatureCss ? sanitizeSignatureCss(content.signatureCss) : null;
  const signatureCss = signature?.ok ? signature.css : '';

  const page = html`<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${content.title}</title>
<meta name="description" content="${content.description}">
<link rel="canonical" href="${siteUrl}">
<meta property="og:type" content="website">
<meta property="og:title" content="${content.title}">
<meta property="og:description" content="${content.description}">
<meta property="og:url" content="${siteUrl}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${googleFontsUrl(brief.fontPairing as FontPairingId)}">
<style>${raw(tokens)}${raw(BASE_CSS)}${raw(theme.css)}${raw(signatureCss)}</style>
</head>
<body>
${theme.body({ content, brief, links: buildLinks(content), t })}
<footer class="coyote-footer">${t.madeWith}<a href="${reportUrl}">${t.report}</a><a href="${privacyUrl}">${t.privacy}</a></footer>
</body>
</html>
`;
  return page.value;
}
