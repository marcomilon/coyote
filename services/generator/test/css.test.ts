import { describe, expect, it } from 'vitest';
import { sanitizeSignatureCss } from '../src/core/css';

const ok = (css: string) => expect(sanitizeSignatureCss(css).ok, css).toBe(true);
const rejected = (css: string) => expect(sanitizeSignatureCss(css).ok, css).toBe(false);

describe('sanitizeSignatureCss', () => {
  it('keeps scoped decorative CSS and re-serializes it', () => {
    const result = sanitizeSignatureCss(`
      .signature { height: 1rem; background: linear-gradient(90deg, var(--accent), var(--ink)); transform: rotate(-2deg) }
      .signature::after { content: ""; position: absolute; inset: 0; clip-path: polygon(0 0, 100% 0, 0 100%) }
      @media (min-width: 48rem) { .signature { width: clamp(8rem, 30vw, 20rem) } }
    `);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.css).toContain('.signature::after');
  });

  it.each([
    ['selector outside the scope', 'body { color: red }'],
    ['second selector outside the scope', '.signature, footer { color: red }'],
    ['sibling combinator escapes the scope', '.signature ~ footer { display: none }'],
    ['adjacent combinator escapes the scope', '.signature + h1 { display: none }'],
    ['url()', '.signature { background: url(https://evil.test/x.png) }'],
    ['url in content', '.signature::before { content: url("https://evil.test/x") }'],
    ['@import', '@import "https://evil.test/x.css"; .signature { color: red }'],
    ['@font-face', '@font-face { font-family: x; src: local("x") }'],
    ['position: fixed', '.signature { position: fixed; inset: 0 }'],
    ['position: sticky', '.signature { position: sticky }'],
    ['property not allowlisted', '.signature { z-index: 9999 }'],
    ['custom property', '.signature { --paper: red }'],
    ['unknown function', '.signature { width: expression(alert(1)) }'],
    ['style breakout', '.signature::before { content: "</style><script>alert(1)</script>" }'],
    ['escaped function name', '.signature { background: u\\72l(https://evil.test) }'],
    ['broken declaration', '.signature { color red; background: }'],
    ['too long', `.signature { color: red } ${'/* x */'.repeat(400)}`],
  ])('rejects %s', (_, css) => rejected(css));

  it('closes an unterminated block instead of leaking it', () => {
    expect(sanitizeSignatureCss('.signature { color: red')).toEqual({ ok: true, css: '.signature{color:red}' });
  });

  it('accepts an empty string', () => ok(''));
});
