export interface FontPairing {
  display: string;
  /** Heading weight. A browser fakes bold when the font has no bold cut, which looks smeared. */
  displayWeight: 400 | 600 | 700 | 800 | 900;
  body: string;
  /** Loose family, used by themes to say which pairings suit them. */
  style: 'serif' | 'sans' | 'contrast' | 'poster' | 'soft';
  /** `family=` values for the Google Fonts css2 API, verbatim. Checked by scripts/check-fonts.ts. */
  google: [string, string];
}

const pairing = (
  display: string, displayFallback: string, displayWeight: FontPairing['displayWeight'], displayQuery: string,
  body: string, bodyFallback: string, bodyQuery: string, style: FontPairing['style'],
): FontPairing => ({
  display: `'${display}', ${displayFallback}`,
  displayWeight,
  body: `'${body}', ${bodyFallback}`,
  style,
  google: [displayQuery, bodyQuery],
});

/** The allowlist. No Inter, Roboto, Arial, Space Grotesk, or Poppins. */
export const FONT_PAIRINGS = {
  'fraunces-worksans': pairing('Fraunces', 'serif', 700, 'Fraunces:opsz,wght@9..144,700', 'Work Sans', 'sans-serif', 'Work+Sans:wght@400;600', 'serif'),
  'dmserif-dmsans': pairing('DM Serif Display', 'serif', 400, 'DM+Serif+Display', 'DM Sans', 'sans-serif', 'DM+Sans:wght@400;600', 'serif'),
  'playfair-karla': pairing('Playfair Display', 'serif', 800, 'Playfair+Display:wght@800', 'Karla', 'sans-serif', 'Karla:wght@400;600', 'serif'),
  'cormorant-jost': pairing('Cormorant Garamond', 'serif', 600, 'Cormorant+Garamond:wght@600', 'Jost', 'sans-serif', 'Jost:wght@400;600', 'serif'),
  'lora-nunitosans': pairing('Lora', 'serif', 700, 'Lora:wght@700', 'Nunito Sans', 'sans-serif', 'Nunito+Sans:wght@400;600', 'serif'),
  'youngserif-instrument': pairing('Young Serif', 'serif', 400, 'Young+Serif', 'Instrument Sans', 'sans-serif', 'Instrument+Sans:wght@400;600', 'serif'),
  'librecaslon-franklin': pairing('Libre Caslon Display', 'serif', 400, 'Libre+Caslon+Display', 'Libre Franklin', 'sans-serif', 'Libre+Franklin:wght@400;600', 'serif'),
  'marcellus-outfit': pairing('Marcellus', 'serif', 400, 'Marcellus', 'Outfit', 'sans-serif', 'Outfit:wght@400;600', 'serif'),
  'bricolage-sourceserif': pairing('Bricolage Grotesque', 'sans-serif', 800, 'Bricolage+Grotesque:wght@800', 'Source Serif 4', 'serif', 'Source+Serif+4:wght@400;600', 'contrast'),
  'syne-manrope': pairing('Syne', 'sans-serif', 800, 'Syne:wght@800', 'Manrope', 'sans-serif', 'Manrope:wght@400;600', 'sans'),
  'familjen-newsreader': pairing('Familjen Grotesk', 'sans-serif', 700, 'Familjen+Grotesk:wght@700', 'Newsreader', 'serif', 'Newsreader:wght@400;600', 'contrast'),
  'chivo-chivo': pairing('Chivo', 'sans-serif', 900, 'Chivo:wght@400;600;900', 'Chivo', 'sans-serif', 'Chivo:wght@400;600;900', 'sans'),
  'sora-sora': pairing('Sora', 'sans-serif', 800, 'Sora:wght@400;600;800', 'Sora', 'sans-serif', 'Sora:wght@400;600;800', 'sans'),
  'archivoblack-archivo': pairing('Archivo Black', 'sans-serif', 400, 'Archivo+Black', 'Archivo', 'sans-serif', 'Archivo:wght@400;600', 'poster'),
  'anton-ibmplex': pairing('Anton', 'sans-serif', 400, 'Anton', 'IBM Plex Sans', 'sans-serif', 'IBM+Plex+Sans:wght@400;600', 'poster'),
  'bebas-mulish': pairing('Bebas Neue', 'sans-serif', 400, 'Bebas+Neue', 'Mulish', 'sans-serif', 'Mulish:wght@400;600', 'poster'),
  'oswald-sourcesans': pairing('Oswald', 'sans-serif', 600, 'Oswald:wght@600', 'Source Sans 3', 'sans-serif', 'Source+Sans+3:wght@400;600', 'poster'),
  'alfaslab-asap': pairing('Alfa Slab One', 'serif', 400, 'Alfa+Slab+One', 'Asap', 'sans-serif', 'Asap:wght@400;600', 'poster'),
  'abril-lato': pairing('Abril Fatface', 'serif', 400, 'Abril+Fatface', 'Lato', 'sans-serif', 'Lato:wght@400;700', 'poster'),
  'unbounded-figtree': pairing('Unbounded', 'sans-serif', 700, 'Unbounded:wght@700', 'Figtree', 'sans-serif', 'Figtree:wght@400;600', 'soft'),
  'baloo-nunito': pairing('Baloo 2', 'sans-serif', 800, 'Baloo+2:wght@800', 'Nunito', 'sans-serif', 'Nunito:wght@400;600', 'soft'),
} as const satisfies Record<string, FontPairing>;

export type FontPairingId = keyof typeof FONT_PAIRINGS;
export const FONT_PAIRING_IDS = Object.keys(FONT_PAIRINGS) as [FontPairingId, ...FontPairingId[]];

export function googleFontsUrl(id: FontPairingId): string {
  const families = [...new Set(FONT_PAIRINGS[id].google)].map((f) => `family=${f}`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
