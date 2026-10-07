import { describe, expect, it } from 'vitest';
import { cleanContact, normalizeAnswers } from '../src/core/answers';
import { Contact } from '../src/core/content';
import { countryOf } from '../src/core/phones';

describe('Contact', () => {
  it('validates phone and email like the WhatsApp number', () => {
    expect(Contact.safeParse({ whatsapp: '573001234567', phone: '576015551234', email: 'hola@luna.test' }).success).toBe(true);
    expect(Contact.safeParse({ whatsapp: '573001234567', phone: '123' }).success).toBe(false);
    expect(Contact.safeParse({ whatsapp: '573001234567', email: 'hola' }).success).toBe(false);
  });

  it('checks a WhatsApp number against its country when the country is listed', () => {
    expect(Contact.safeParse({ whatsapp: '573001234567' }).success).toBe(true); // Colombia, 10 digits
    expect(Contact.safeParse({ whatsapp: '57300123456' }).success).toBe(false); // one short
    expect(Contact.safeParse({ whatsapp: '5491123456789' }).success).toBe(true); // Argentina with the mobile 9
    expect(Contact.safeParse({ whatsapp: '541123456789' }).success).toBe(false); // without it
    expect(Contact.safeParse({ whatsapp: '59894231234' }).success).toBe(true); // Uruguay, 3-digit code
    expect(Contact.safeParse({ whatsapp: '13051234567' }).success).toBe(true); // +1
    expect(Contact.safeParse({ whatsapp: '442079460958' }).success).toBe(true); // not listed: only 8 to 15 digits
    expect(countryOf('5511912345678')?.iso).toBe('BR');
    expect(countryOf('59171234567')?.iso).toBe('BO');
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

  it('takes an optional business email, lowercased', () => {
    const base = { businessName: 'Panadería Luna', about: 'Panadería de masa madre en Chapinero, Bogotá.', whatsapp: '+57 300 123 4567' };
    expect(normalizeAnswers({ ...base, email: ' Hola@Luna.test ' }).contact.email).toBe('hola@luna.test');
    expect(normalizeAnswers({ ...base, email: '' }).contact.email).toBeUndefined();
    expect(() => normalizeAnswers({ ...base, email: 'hola' })).toThrow();
  });
});
