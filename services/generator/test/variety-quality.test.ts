import { describe, expect, it } from 'vitest';
import { THEMES } from '../themes';
import { contrast } from '../src/core/color';
import { FONT_PAIRINGS } from '../src/core/fonts';
import { checkHtml } from '../src/core/policy';
import { fixBrief, lintContent } from '../src/core/quality';
import { render } from '../src/core/render';
import { candidatesFor } from '../src/core/variety';
import { brief, content } from './fixtures';

const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;

describe('candidatesFor', () => {
  it('is deterministic per slug and offers 3 themes with 3 compatible pairings each', () => {
    const a = candidatesFor('panaderia-luna');
    expect(candidatesFor('panaderia-luna')).toEqual(a);
    expect(a).toHaveLength(3);
    for (const candidate of a) {
      expect(candidate.fontPairings).toHaveLength(3);
      for (const id of candidate.fontPairings) expect(candidate.theme.meta.fontStyles).toContain(FONT_PAIRINGS[id].style);
    }
  });

  it('spreads themes across slugs', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) for (const c of candidatesFor(`negocio-${i}`)) counts.set(c.theme.id, (counts.get(c.theme.id) ?? 0) + 1);
    expect(counts.size).toBe(Object.keys(THEMES).length);
    for (const count of counts.values()) expect(count).toBeGreaterThan(100); // 150 expected each
  });
});

describe('fixBrief', () => {
  const candidates = candidatesFor('panaderia-luna');
  const first = candidates[0]!;
  const base = { ...brief, theme: first.theme.id, fontPairing: first.fontPairings[1]!, palette: first.theme.meta.defaultPalette };

  it('keeps a valid brief', () => expect(fixBrief(base, candidates)).toEqual(base));

  it('replaces a font that does not belong to the theme, and an unknown theme', () => {
    expect(fixBrief({ ...base, fontPairing: 'not-a-font' }, candidates).fontPairing).toBe(first.fontPairings[0]);
    expect(fixBrief({ ...base, theme: 'nope' }, candidates).theme).toBe(first.theme.id);
  });

  it('replaces an unreadable palette and one that ignores the scheme', () => {
    const lowContrast = { ink: '#777777', paper: '#888888', accent: '#999999' };
    expect(fixBrief({ ...base, palette: lowContrast }, candidates).palette).toEqual(first.theme.meta.defaultPalette);
    const wrongScheme = first.theme.meta.scheme === 'dark' ? { ink: '#111111', paper: '#ffffff', accent: '#aa0000' } : { ink: '#ffffff', paper: '#111111', accent: '#ffcc00' };
    expect(fixBrief({ ...base, palette: wrongScheme }, candidates).palette).toEqual(first.theme.meta.defaultPalette);
  });
});

describe('lintContent', () => {
  it('passes concrete copy', () => expect(lintContent(modelContent, 'es')).toEqual([]));
  it('flags banned phrases, long headlines, emoji, and hype', () => {
    expect(lintContent({ ...modelContent, about: 'Bienvenidos a la mejor panadería.' }, 'es')).toHaveLength(1);
    expect(lintContent({ ...modelContent, headline: 'El mejor pan de masa madre de todo el barrio de Chapinero' }, 'es')).toHaveLength(1);
    expect(lintContent({ ...modelContent, subhead: 'Pan recién hecho 🥖' }, 'es')).toHaveLength(1);
    expect(lintContent({ ...modelContent, subhead: 'Ven ya!!' }, 'es')).toHaveLength(1);
    expect(lintContent({ ...modelContent, about: 'Sua satisfação é nossa prioridade.' }, 'pt')).toHaveLength(1);
  });
});

describe('every theme', () => {
  it.each(Object.values(THEMES))('$id renders within the HTML policy, with a signature element and a readable default palette', (theme) => {
    const fontPairing = Object.keys(FONT_PAIRINGS).find((id) => theme.meta.fontStyles.includes(FONT_PAIRINGS[id as keyof typeof FONT_PAIRINGS].style))!;
    const page = render({
      theme,
      content,
      brief: { ...brief, theme: theme.id, fontPairing, palette: theme.meta.defaultPalette },
      siteUrl: 'https://sites.test/x/',
      reportUrl: 'https://app.test/reportar?sitio=x',
      privacyUrl: 'https://app.test/privacidad',
    });
    expect(checkHtml(page, { platformOrigins: ['https://app.test', 'https://sites.test'] })).toEqual([]);
    expect(page).toContain('class="signature"');
    expect(page).toContain('https://wa.me/573001234567');
    expect(page).toContain(content.headline);
    const { ink, paper, accent } = theme.meta.defaultPalette;
    expect(contrast(ink, paper)).toBeGreaterThanOrEqual(7);
    expect(contrast(accent, paper)).toBeGreaterThanOrEqual(3);
  });

  it('has at least 3 compatible font pairings', () => {
    for (const theme of Object.values(THEMES)) {
      const compatible = Object.values(FONT_PAIRINGS).filter((p) => theme.meta.fontStyles.includes(p.style));
      expect(compatible.length, theme.id).toBeGreaterThanOrEqual(3);
    }
  });
});
