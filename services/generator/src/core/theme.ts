import type { Brief } from './brief';
import type { SiteContent } from './content';
import type { SafeHtml } from './html';
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
}

export interface Theme {
  id: string;
  meta: {
    name: string;
    industries: string[];
    moods: string[];
    scheme: 'light' | 'dark';
  };
  /** Static, hand-written CSS. Uses --ink, --paper, --accent, --font-display, --font-body. */
  css: string;
  /**
   * Everything inside <body> except the platform footer. Must include one `.signature` element
   * (decorative, `position: relative; overflow: hidden`) for the model's signatureCss.
   */
  body(input: ThemeInput): SafeHtml;
}
