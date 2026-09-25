import { describe, expect, it } from 'vitest';
import { cleanContact, normalizeAnswers } from '../src/core/answers';
import { Contact } from '../src/core/content';

describe('Contact', () => {
  it('validates phone and email like the WhatsApp number', () => {
    expect(Contact.safeParse({ whatsapp: '573001234567', phone: '576015551234', email: 'hola@luna.test' }).success).toBe(true);
    expect(Contact.safeParse({ whatsapp: '573001234567', phone: '123' }).success).toBe(false);
    expect(Contact.safeParse({ whatsapp: '573001234567', email: 'hola' }).success).toBe(false);
  });

  it('cleans raw values the way the form does', () => {
    expect(cleanContact('phone', '+57 (601) 555-1234')).toBe('576015551234');
    expect(cleanContact('email', ' Hola@Luna.test ')).toBe('hola@luna.test');
    expect(cleanContact('instagram', 'https://instagram.com/luna.pan/')).toBe('luna.pan');
    expect(cleanContact('address', '   ')).toBeUndefined();
  });
});
describe('normalizeAnswers', () => {
  it('cleans the phone and social handles', () => {
    const answers = normalizeAnswers({
      businessName: 'Panadería Luna',
      about: 'Panadería de masa madre en Chapinero, Bogotá.',
      whatsapp: '+57 (300) 123-4567',
      instagram: 'https://www.instagram.com/panaderia.luna/?hl=es',
      facebook: '@panaderialuna',
    });
    expect(answers.contact).toEqual({ whatsapp: '573001234567', instagram: 'panaderia.luna', facebook: 'panaderialuna' });
    expect(answers.lang).toBe('es');
  });
});
