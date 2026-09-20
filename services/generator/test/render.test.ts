import { describe, expect, it } from 'vitest';
import { render } from '../src/core/render';
import { plain } from '../themes/plain';
import { brief, content } from './fixtures';

const base = {
  theme: plain,
  brief,
  siteUrl: 'https://sites.test/panaderia-luna/',
  reportUrl: 'https://app.test/reportar?sitio=panaderia-luna',
  privacyUrl: 'https://app.test/privacidad',
};

describe('render', () => {
  it('is deterministic', () => {
    expect(render({ ...base, content })).toBe(render({ ...base, content }));
  });

  it('escapes every model and user value', () => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    const page = render({
      ...base,
      content: {
        ...content,
        businessName: evil,
        title: evil,
        description: evil,
        headline: evil,
        subhead: evil,
        about: evil,
        ctaText: evil,
        services: [{ name: evil, detail: evil }],
        hours: [{ days: evil, time: evil }],
        location: { neighborhood: evil, city: evil },
        contact: { ...content.contact, address: evil },
      },
    });
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).not.toMatch(/"\s*onerror/);
    expect(page).toContain('&lt;script&gt;');
  });

  it('builds links only from contact fields, with the number unchanged', () => {
    const page = render({ ...base, content });
    const hrefs = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.filter((h) => h.startsWith('https://wa.me/')).every((h) => h.startsWith('https://wa.me/573001234567?text='))).toBe(true);
    expect(hrefs).toContain('https://instagram.com/panaderia.luna');
    const allowed = /^https:\/\/(wa\.me|instagram\.com|facebook\.com|maps\.google\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|sites\.test|app\.test)(\/|$)/;
    expect(hrefs.filter((h) => !allowed.test(h))).toEqual([]);
  });

  it('always has the platform footer, meta tags, and the page language', () => {
    const page = render({ ...base, content: { ...content, lang: 'pt' } });
    expect(page).toContain('<html lang="pt-BR">');
    expect(page).toContain('Site criado com Coyote');
    expect(page).toContain(`href="${base.reportUrl.replace('&', '&amp;')}"`);
    expect(page).toContain('<link rel="canonical" href="https://sites.test/panaderia-luna/">');
    expect(page).toContain('property="og:title"');
  });

  it('keeps valid signatureCss and drops invalid signatureCss', () => {
    expect(render({ ...base, content: { ...content, signatureCss: '.signature{height:2rem}' } })).toContain('.signature{height:2rem}');
    expect(render({ ...base, content: { ...content, signatureCss: 'body{display:none}' } })).not.toContain('display:none');
  });

  it('rejects a palette that is not hex', () => {
    expect(() =>
      render({ ...base, content, brief: { ...brief, palette: { ...brief.palette, accent: 'red;}</style>' } } }),
    ).toThrow();
  });
});
