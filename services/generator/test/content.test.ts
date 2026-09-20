import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeAnswers } from '../src/core/answers';
import { applyPatch, ModelContent } from '../src/core/content';
import { content } from './fixtures';

describe('ModelContent', () => {
  it('has no contact fields the model could fill', () => {
    const schema = z.toJSONSchema(ModelContent) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toEqual(expect.arrayContaining(['contact', 'whatsapp', 'address']));
  });
});

describe('applyPatch', () => {
  it('changes hours and contact without touching the rest', () => {
    const next = applyPatch(content, {
      hours: [{ days: 'Lunes a viernes', time: '9:00 – 18:00' }],
      contact: { instagram: 'luna.pan' },
    });
    expect(next.hours).toEqual([{ days: 'Lunes a viernes', time: '9:00 – 18:00' }]);
    expect(next.contact).toEqual({ ...content.contact, instagram: 'luna.pan' });
    expect(next.headline).toBe(content.headline);
    expect(content.contact.instagram).toBe('panaderia.luna'); // input not mutated
  });

  it('rejects fields an owner may not edit', () => {
    expect(() => applyPatch(content, { signatureCss: 'body{}' })).toThrow();
    expect(() => applyPatch(content, { title: 'x' })).toThrow();
  });

  it('rejects an invalid WhatsApp number', () => {
    expect(() => applyPatch(content, { contact: { whatsapp: '+57 300' } })).toThrow();
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
