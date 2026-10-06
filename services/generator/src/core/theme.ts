import type { Brief } from './brief';
import type { SiteContent } from './content';
import type { SafeHtml } from './html';
import type { FontPairing } from './fonts';
import type { Strings } from './i18n';

/** Links are built by the renderer from typed contact fields, never taken from model text. */
export interface SiteLinks {
  whatsapp: string;
  /** tel: and mailto: links, when the owner gave a phone or an email (the form, a question, or Mi sitio). */
  phone?: string;
  email?: string;
  instagram?: string;
  facebook?: string;
  maps?: string;
}

export interface ThemeInput {
  content: SiteContent;
  brief: Brief;
  links: SiteLinks;
  t: Strings;
  /** The business logo: the uploaded image, or a generated SVG mark. Ready to place. */
  logo: SafeHtml;
  /** Uploaded photos as ready-to-place <img> elements. Often empty: a theme must look good without them. */
  photos: SafeHtml[];
  /** A Google map of the address (an <iframe class="map">), or undefined when there is no address. Put it in a sized box. */
  map?: SafeHtml;
}

export interface Theme {
  id: string;
  meta: {
    name: string;
    industries: string[];
    moods: string[];
    scheme: 'light' | 'dark';
    /** Which font pairing styles suit this theme. */
    fontStyles: FontPairing['style'][];
    /** Used when the model's palette is unreadable or does not match the scheme. */
    defaultPalette: { ink: string; paper: string; accent: string };
  };
  /**
   * Static, hand-written CSS. Tokens: --ink, --paper, --accent, --on-accent (readable text on the accent),
   * --font-display, --font-display-weight, --font-body. Derive tints with color-mix().
   */
  css: string;
  /**
   * Optional JavaScript for animations (scroll reveals, a menu). Our own code, never model output. It runs
   * inline at the end of the page and is allowed by the sites CSP through its SHA-256 hash. It must be
   * progressive: the page is complete without it, and it respects prefers-reduced-motion.
   */
  script?: string;
  /** Uses Tailwind classes: `npm run themes:tailwind` compiles them into themes/generated/tailwind.ts. */
  tailwind?: boolean;
  /**
   * Everything inside <body> except the platform footer. Must place `logo`, use `photos` when there are
   * any (the first is the hero image), and include one `.signature` element
   * (decorative, `position: relative; overflow: hidden`) for the model's signatureCss. Put no content in it
   * (no hours, no text): the model's CSS restyles it freely.
   */
  body(input: ThemeInput): SafeHtml;
}
