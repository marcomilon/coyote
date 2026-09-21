import { describe, expect, it } from 'vitest';
import { checkContent, checkHtml, scrubModelContent, scrubText } from '../src/core/policy';
import { render } from '../src/core/render';
import { editorial as plain } from '../themes/editorial';
import { brief, content } from './fixtures';

const codes = (violations: { code: string }[]) => violations.map((v) => v.code);

describe('checkContent', () => {
  it('passes a normal business', () => {
    expect(checkContent(content)).toEqual([]);
  });

  it.each([
    ['an accountant mentioning the tax agency', { headline: 'Declaraciones ante el SAT sin estrés' }],
    ['a WhatsApp call to action as headline', { headline: 'Pide tu pastel por WhatsApp' }],
    ['"clave" used as a normal word', { about: 'La clave de nuestro pan es la fermentación lenta. Escribe y te contamos.' }],
    ['a phone-like number', { about: 'Atendemos pedidos grandes con 48 horas de anticipación, mínimo 12 unidades.' }],
    ['card brands accepted', { about: 'Aceptamos Visa, Mastercard y Pix.' }],
  ])('allows %s', (_, fields) => {
    expect(checkContent({ ...content, ...fields })).toEqual([]);
  });

  it.each([
    ['bank as business name', { businessName: 'Bancolombia Soporte' }, 'brand'],
    ['spaced bank name', { businessName: 'Banco  Azteca en línea' }, 'brand'],
    ['platform as business name', { businessName: 'WhatsApp Premium' }, 'brand'],
    ['tax agency as business name', { businessName: 'SAT Citas' }, 'brand'],
    ['bank in the headline', { headline: 'Tu Nubank, más cerca' }, 'brand'],
    ['courier in the title', { title: 'DHL — rastrea tu paquete' }, 'brand'],
    ['scam phrase (es)', { subhead: 'Verifica tu cuenta para evitar el bloqueo.' }, 'scam-phrase'],
    ['scam phrase (pt)', { about: 'Atualize seus dados hoje mesmo.' }, 'scam-phrase'],
    ['prize bait', { headline: 'Llama ya para tu premio' }, 'scam-phrase'],
    ['credential request', { about: 'Envíanos tu contraseña y el código de verificación por WhatsApp.' }, 'credential-request'],
    ['credential request (pt)', { about: 'Digite sua senha para continuar.' }, 'credential-request'],
    ['card number', { about: 'Paga a la tarjeta 4111 1111 1111 1111.' }, 'card-number'],
  ])('rejects %s', (_, fields, code) => {
    expect(codes(checkContent({ ...content, ...fields }))).toContain(code);
  });

  it('checks user-provided fields too', () => {
    const tampered = { ...content, contact: { ...content.contact, address: 'Ingresa tu PIN en la entrada' } };
    expect(codes(checkContent(tampered))).toContain('credential-request');
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

  it('scrubs every model text field', () => {
    const { businessName: _n, lang: _l, contact: _c, media: _m, ...model } = content;
    const scrubbed = scrubModelContent({ ...model, about: 'Compra en tienda.test.com hoy', services: [{ name: 'Pan', detail: 'Ver www.x.com' }] });
    expect(scrubbed.about).toBe('Compra en hoy');
    expect(scrubbed.services[0]?.detail).toBe('Ver');
  });
});

describe('checkHtml', () => {
  const options = { platformOrigins: ['https://app.test', 'https://sites.test'] };
  const page = render({
    theme: plain,
    brief,
    content: { ...content, contact: { ...content.contact, facebook: 'panaderialuna' } },
    siteUrl: 'https://sites.test/panaderia-luna/',
    reportUrl: 'https://app.test/reportar?sitio=panaderia-luna',
    privacyUrl: 'https://app.test/privacidad',
  });
  const withBody = (markup: string) => page.replace('</body>', `${markup}</body>`);

  it('passes a rendered page', () => {
    expect(checkHtml(page, options)).toEqual([]);
  });

  it.each([
    ['script', '<script>alert(1)</script>', 'forbidden-element'],
    ['iframe', '<iframe src="https://evil.test"></iframe>', 'forbidden-element'],
    ['object', '<object data="x.swf"></object>', 'forbidden-element'],
    ['base', '<base href="https://evil.test/">', 'forbidden-element'],
    ['meta refresh', '<meta http-equiv="Refresh" content="0;url=https://evil.test">', 'forbidden-element'],
    ['event handler', '<img src="assets/a.webp" onerror="alert(1)">', 'forbidden-attribute'],
    ['javascript: link', '<a href="javascript:alert(1)">x</a>', 'forbidden-url'],
    ['link to another site', '<a href="https://evil.test/login">x</a>', 'forbidden-url'],
    ['http link', '<a href="http://wa.me/573001234567">x</a>', 'forbidden-url'],
    ['protocol-relative link', '<a href="//evil.test">x</a>', 'forbidden-url'],
    ['remote image', '<img src="https://evil.test/pixel.gif">', 'forbidden-url'],
    ['absolute-path image', '<img src="/other-site/assets/a.webp">', 'forbidden-url'],
    ['remote stylesheet', '<link rel="stylesheet" href="https://evil.test/x.css">', 'forbidden-url'],
    ['prefetch link', '<link rel="prefetch" href="assets/x">', 'forbidden-element'],
    ['any form in the MVP', '<form method="post" action="https://api.test/contact/x" data-coyote-contact></form>', 'forbidden-form'],
    ['password field', '<input type="password">', 'forbidden-form'],
    ['stray input', '<input type="text" name="tarjeta">', 'forbidden-form'],
    ['remote url in a style attribute', '<div style="background:url(https://evil.test/x.png)"></div>', 'forbidden-css'],
    ['@import in a style element', '<style>@import "https://evil.test/x.css";</style>', 'forbidden-css'],
  ])('rejects %s', (_, markup, code) => {
    expect(codes(checkHtml(withBody(markup), options))).toContain(code);
  });

  it('allows tel:, mailto:, fragments, relative assets, and data: images in CSS', () => {
    const markup =
      '<a href="tel:+573001234567">x</a><a href="mailto:hola@luna.test">x</a><a href="#contacto">x</a>' +
      '<img src="assets/foto-1.webp"><div style="background:url(data:image/svg+xml;base64,AAAA)"></div>';
    expect(checkHtml(withBody(markup), options)).toEqual([]);
  });

  it('allows only the exact theme contact form once it is enabled', () => {
    const action = 'https://api.test/contact/panaderia-luna';
    const form = (a: string, extra = '') =>
      `<form method="post" action="${a}" data-coyote-contact><input name="nombre"><textarea name="mensaje"></textarea><input type="hidden" name="_t">${extra}<button type="submit">Enviar</button></form>`;
    expect(checkHtml(withBody(form(action)), { ...options, contactFormAction: action })).toEqual([]);
    expect(codes(checkHtml(withBody(form('https://evil.test/collect')), { ...options, contactFormAction: action }))).toContain('forbidden-form');
    expect(codes(checkHtml(withBody(form(action, '<input type="password" name="clave">')), { ...options, contactFormAction: action }))).toContain('forbidden-form');
  });
});
