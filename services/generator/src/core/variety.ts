import { THEMES } from '../../themes';
import { FONT_PAIRINGS, FONT_PAIRING_IDS, type FontPairingId } from './fonts';
import type { Theme } from './theme';

export interface Candidate {
  theme: Theme;
  fontPairings: FontPairingId[];
}

const CANDIDATE_THEMES = 3;
const CANDIDATE_FONTS = 3;

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * The model chooses among a few seeded candidates instead of the whole library, so the fleet of sites
 * cannot drift to one favorite theme or font. Same slug, same candidates.
 */
export function candidatesFor(slug: string): Candidate[] {
  const random = seeded(slug);
  return shuffled(Object.values(THEMES), random)
    .slice(0, CANDIDATE_THEMES)
    .map((theme) => ({
      theme,
      fontPairings: shuffled(
        FONT_PAIRING_IDS.filter((id) => theme.meta.fontStyles.includes(FONT_PAIRINGS[id].style)),
        random,
      ).slice(0, CANDIDATE_FONTS),
    }));
}
