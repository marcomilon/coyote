import { describe, expect, it } from 'vitest';
import { checkTexts, contactInText, scrubText } from '../src/core/policy';

const codes = (violations: { code: string }[]) => violations.map((v) => v.code);

/** The page's texts, as page-check.ts passes them: every text, and the business name and headlines for brand checks. */
const check = ({ businessName = 'Panadería Luna', headline = 'Pan de masa madre, cada mañana en Chapinero', texts = [] as string[] } = {}) =>
  checkTexts([businessName, headline, 'Somos una panadería de barrio en Chapinero.', ...texts], { businessName, headlines: [headline] });

describe('checkTexts', () => {
  it('passes a normal business', () => {
    expect(check()).toEqual([]);
  });

  it.each([
    ['an accountant mentioning the tax agency', { headline: 'Declaraciones ante el SAT sin estrés' }],
    ['a WhatsApp call to action as headline', { headline: 'Pide tu pastel por WhatsApp' }],
    ['"clave" used as a normal word', { texts: ['La clave de nuestro pan es la fermentación lenta. Escribe y te contamos.'] }],
    ['a phone-like number', { texts: ['Atendemos pedidos grandes con 48 horas de anticipación, mínimo 12 unidades.'] }],
    ['card brands accepted', { texts: ['Aceptamos Visa, Mastercard y Pix.'] }],
  ])('allows %s', (_, page) => {
    expect(check(page)).toEqual([]);
  });

  it.each([
    ['bank as business name', { businessName: 'Bancolombia Soporte' }, 'brand'],
    ['spaced bank name', { businessName: 'Banco  Azteca en línea' }, 'brand'],
    ['platform as business name', { businessName: 'WhatsApp Premium' }, 'brand'],
    ['tax agency as business name', { businessName: 'SAT Citas' }, 'brand'],
    ['bank in the headline', { headline: 'Tu Nubank, más cerca' }, 'brand'],
    ['courier in the title', { headline: 'DHL — rastrea tu paquete' }, 'brand'],
    ['scam phrase (es)', { texts: ['Verifica tu cuenta para evitar el bloqueo.'] }, 'scam-phrase'],
    ['scam phrase (pt)', { texts: ['Atualize seus dados hoje mesmo.'] }, 'scam-phrase'],
    ['prize bait', { headline: 'Llama ya para tu premio' }, 'scam-phrase'],
    ['credential request', { texts: ['Envíanos tu contraseña y el código de verificación por WhatsApp.'] }, 'credential-request'],
    ['credential request (pt)', { texts: ['Digite sua senha para continuar.'] }, 'credential-request'],
    ['card number', { texts: ['Paga a la tarjeta 4111 1111 1111 1111.'] }, 'card-number'],
    ['an address the owner typed', { texts: ['Ingresa tu PIN en la entrada'] }, 'credential-request'],
  ])('rejects %s', (_, page, code) => {
    expect(codes(check(page))).toContain(code);
  });
});

describe('scrubText', () => {
  it.each([
    ['Visítanos en https://evil.test/login ahora', 'Visítanos en ahora'],
    ['Entra a www.banco-seguro.com.mx/acceso.', 'Entra a'],
    ['Pedidos en panaderialuna.com', 'Pedidos en'],
    ['Abrimos de 7 a 19. Pan desde $3.500', 'Abrimos de 7 a 19. Pan desde $3.500'],
    ['Llama ya al +57 311 999 0000 hoy', 'Llama ya al hoy'],
    ['Escríbenos al (55) 1234-5678.', 'Escríbenos al.'],
    ['Desde 1998, más de 20.000 clientes y 3 sedes', 'Desde 1998, más de 20.000 clientes y 3 sedes'],
  ])('%s', (input, output) => expect(scrubText(input)).toBe(output));
});

describe('contactInText', () => {
  it.each([
    ['Llama al +57 311 999 0000', true],
    ['Escríbenos a hola@luna.co', true],
    ['Visita www.luna.com.co', true],
    ['Abrimos de 9:00 a 18:00', false],
    ['Hogaza a $18.000.000 para eventos', false],
    ['Más de 20.000 clientes desde 1998', false],
  ])('%s', (text, found) => expect(contactInText(text).length > 0).toBe(found));
});
