import type { Brief } from './brief';
import type { SiteContent } from './content';
import type { SafeHtml } from './html';
import type { FontPairing } from './fonts';
import type { Strings } from './i18n';

/** Links are built by the renderer from typed contact fields, never taken from model text. */
export interface SiteLinks {
  whatsapp: string;
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
   * Everything inside <body> except the platform footer. Must place `logo`, use `photos` when there are
   * any (the first is the hero image), and include one `.signature` element
   * (decorative, `position: relative; overflow: hidden`) for the model's signatureCss.
   */
  body(input: ThemeInput): SafeHtml;
}
