import { describe, expect, it } from 'vitest';
import { usesVoseo, voiceOf } from '../src/core/i18n';
import { readyEmail } from '../src/core/mail';

describe('voiceOf', () => {
  it('uses vos for Spanish sites with a phone in Argentina, Uruguay or Paraguay', () => {
    for (const whatsapp of ['+54 9 11 5555 0193', '+598 94 123 456', '+595 981 123456']) {
      expect(voiceOf({ lang: 'es', contact: { whatsapp } }), whatsapp).toBe('vos');
    }
  });
  it('uses tú elsewhere, and Portuguese stays Portuguese', () => {
    expect(voiceOf({ lang: 'es', contact: { whatsapp: '+57 304 555 0187' } })).toBe('es');
    expect(voiceOf({ lang: 'es', contact: { whatsapp: '' } })).toBe('es');
    expect(voiceOf({ lang: 'pt', contact: { whatsapp: '+54 9 11 5555 0193' } })).toBe('pt');
  });
  it('knows the voseo countries', () => {
    expect(usesVoseo('AR')).toBe(true);
    expect(usesVoseo('MX')).toBe(false);
    expect(usesVoseo(undefined)).toBe(false);
  });
});

describe('readyEmail', () => {
  it('speaks vos to a voseo site', () => {
    const email = readyEmail('a@b.test', 'vos', 'Salón Luna', 'https://app.test/x', 'https://app.test');
    expect(email.text).toContain('Mirala y pedí cambios');
    expect(email.html).toContain('Copiá este enlace');
    expect(readyEmail('a@b.test', 'es', 'Salón Luna', 'https://app.test/x', 'https://app.test').text).toContain('Mírala y pide cambios');
  });
});
