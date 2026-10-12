import { describe, expect, it } from 'vitest';
import { EXAMPLE_ABOUT, isOurExample } from '../src/core/example-about';

describe('isOurExample', () => {
  it('catches our examples copied back, give or take punctuation, accents, case, and a word or two', () => {
    expect(isOurExample('Panadería en Rosario: pan de masa madre y tortas por encargo')).toBe(true);
    expect(isOurExample('«panaderia en rosario pan de masa madre y tortas por encargo».')).toBe(true);
    expect(isOurExample('Mi negocio: Panadería en Cusco: pan de masa madre y tortas por encargo')).toBe(true);
    expect(isOurExample(EXAMPLE_ABOUT.pt.placeholder.replace('…', ''))).toBe(true);
  });

  it('lets a real description through, even one that starts like an example', () => {
    expect(isOurExample('Panadería en Rosario: pan de masa madre y tortas por encargo. También hacemos alfajores, budines y pastafrolas para eventos.')).toBe(false);
    expect(isOurExample('Panadería de barrio en Rosario, pan francés y facturas')).toBe(false);
  });
});
