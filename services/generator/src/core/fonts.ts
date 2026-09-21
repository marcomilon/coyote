export interface FontPairing {
  display: string;
  /** Heading weight. A browser fakes bold when the font has no bold cut, which looks smeared. */
  displayWeight: 400 | 700 | 800;
  body: string;
  /** `family=` values for the Google Fonts css2 API, verbatim. */
  google: [string, string];
}

/** Allowlist of pairings. Phase 2a grows this to ~20. No Inter/Roboto/Arial/Space Grotesk/Poppins. */
export const FONT_PAIRINGS = {
  'fraunces-worksans': {
    display: "'Fraunces', serif",
    displayWeight: 700,
    body: "'Work Sans', sans-serif",
    google: ['Fraunces:opsz,wght@9..144,400;9..144,700', 'Work+Sans:wght@400;600'],
  },
  'dmserif-dmsans': {
    display: "'DM Serif Display', serif",
    displayWeight: 400,
    body: "'DM Sans', sans-serif",
    google: ['DM+Serif+Display', 'DM+Sans:wght@400;600'],
  },
  'bricolage-sourceserif': {
    display: "'Bricolage Grotesque', sans-serif",
    displayWeight: 800,
    body: "'Source Serif 4', serif",
    google: ['Bricolage+Grotesque:wght@400;800', 'Source+Serif+4:wght@400;600'],
  },
} as const satisfies Record<string, FontPairing>;

export type FontPairingId = keyof typeof FONT_PAIRINGS;
export const FONT_PAIRING_IDS = Object.keys(FONT_PAIRINGS) as [FontPairingId, ...FontPairingId[]];

export function googleFontsUrl(id: FontPairingId): string {
  const families = FONT_PAIRINGS[id].google.map((f) => `family=${f}`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
