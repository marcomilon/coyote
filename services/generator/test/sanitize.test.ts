import { describe, expect, it } from 'vitest';
import { renderDraft, type SiteDoc } from '../src/core/drafts';
import { checkHtml } from '../src/core/policy';
import { checkQuestions } from '../src/core/questions';
import { sanitizePage } from '../src/core/sanitize';
import { MODEL_PAGE } from './fixtures';
import { urls } from './harness';

const inBody = (markup: string) => MODEL_PAGE.replace('</main>', `${markup}</main>`);
const inStyle = (css: string) => MODEL_PAGE.replace('</style>', `${css}</style>`);
const violations = (page: string) => sanitizePage(page).violations.join('\n');

describe('sanitizePage', () => {
  it('keeps a good page, with its placeholders, and finds its text', () => {
    const result = sanitizePage(MODEL_PAGE);
    expect(result.violations).toEqual([]);
    expect(result.lint).toEqual([]);
    expect(result.html).toContain('href="{{whatsapp_url}}"');
    expect(result.html).toContain('viewBox="0 0 24 24"');
    expect(result.text.h1).toEqual(['Pan de masa madre, cada mañana en Chapinero']);
    expect(result.text.title).toBe('Panadería Luna — masa madre en Chapinero');
    expect(result.text.texts).toEqual(expect.arrayContaining(['Nuestro pan', 'Cómo llegar', 'Panadería Luna', 'Pan de masa madre horneado cada mañana en Chapinero.']));
    // Sanitizing the output again changes nothing.
    expect(sanitizePage(result.html).html).toBe(result.html);
  });

  describe('hostile pages', () => {
    it.each([
      ['a script from another host', '<script src="https://evil.test/x.js"></script>', 'scripts may only load from'],
      ['an iframe', '<iframe src="https://evil.test/login"></iframe>', '<iframe> is not allowed'],
      ['an object', '<object data="x.swf"></object>', '<object> is not allowed'],
      ['a fake login form', '<form action="https://evil.test/collect" method="post"><input name="usuario"><input type="password" name="clave"><button>Entrar</button></form>', '<form> is not allowed'],
      ['a stray input', '<input name="tarjeta" placeholder="Número de tarjeta">', '<input> is not allowed'],
      ['a javascript: link', '<a href="javascript:alert(1)">x</a>', 'links may only be'],
      ['a smuggled wa.me link', '<a href="https://wa.me/5215555555555">Escríbenos</a>', 'links may only be'],
      ['a link to another site', '<a href="https://evil.test/login">Ingresa</a>', 'links may only be'],
      ['an http image', '<img src="http://evil.test/pixel.gif" alt="" width="1" height="1">', 'use {{hero}}'],
      ['a stylesheet from another host', '<link rel="stylesheet" href="https://evil.test/x.css">', 'only stylesheets and preconnects from'],
      ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '[http-equiv] is not allowed'],
      ['a base element', '<base href="https://evil.test/">', '<base> is not allowed'],
      ['the hidden attribute', '<p hidden>Palabras clave ocultas</p>', 'hidden text is not allowed'],
      ['an unknown placeholder', '<p>{{owner_home_address}}</p>', '{{owner_home_address}} is not allowed'],
      ['a placeholder in an attribute', '<p class="{{whatsapp_url}}">x</p>', 'is not allowed here'],
      ['a second map slot', '<div data-slot="map"></div>', 'only one <div data-slot="map">'],
      ['content inside the map slot', '<div data-slot="map"><a href="#">x</a></div>', 'must be empty'],
    ])('rejects %s', (_, markup, message) => {
      expect(violations(inBody(markup))).toContain(message);
    });

    it.each([
      ['a javascript: url()', '.x{background:url("javascript:alert(1)")}', 'is not allowed. Use {{hero}}'],
      ['a protocol-relative url()', '.x{background-image:url("//evil.test/x.png")}', 'is not allowed. Use {{hero}}'],
      ['@import', '@import "https://evil.test/x.css";', '@import is not allowed'],
      ['@font-face', '@font-face{font-family:x;src:url(https://evil.test/f.woff2)}', '@font-face is not allowed'],
      ['markup in CSS', '.x::after{content:"<b>"}', '"<" is not allowed in CSS'],
      ['a legacy binding', '.x{-moz-binding:url(x.xml#y)}', '-moz-binding is not allowed'],
    ])('rejects %s', (_, css, message) => {
      expect(violations(inStyle(css))).toContain(message);
    });

    it.each([
      ['display: none', '.seo{display:none}', '<p class="seo">Mejores precios del mercado</p>'],
      ['visibility: hidden', '.seo{visibility:hidden}', '<p class="seo">texto</p>'],
      ['opacity: 0', 'main .seo{opacity:0}', '<p class="seo">texto</p>'],
      ['font-size: 0', '.seo{font-size:0}', '<div class="seo">texto</div>'],
      ['transparent text', '.seo{color:transparent}', '<p class="seo">texto</p>'],
      ['off-screen', '.seo{position:absolute;left:-9999px}', '<p class="seo">texto</p>'],
      ['a text-indent trick', '.seo{text-indent:-9999px}', '<p class="seo">texto</p>'],
      ['clip-path', '.seo{clip-path:inset(50%)}', '<p class="seo">texto</p>'],
      ['a hidden ancestor', '#oculto{display:none}', '<div id="oculto"><p>texto</p></div>'],
      ['an always-true media query', '@media (min-width:1px){.seo{display:none}}', '<p class="seo">texto</p>'],
    ])('rejects hidden text: %s', (_, css, markup) => {
      expect(violations(inStyle(css).replace('</main>', `${markup}</main>`))).toContain('hidden text is not allowed');
    });

    it('allows hiding text at one screen width (responsive design), not with an always-true query', () => {
      const bar = '<div class="bar">Escríbenos</div>';
      expect(sanitizePage(inStyle('@media (min-width:768px){.bar{display:none}}').replace('</main>', `${bar}</main>`)).violations).toEqual([]);
      expect(violations(inStyle('@media (min-width:0px){.bar{display:none}}').replace('</main>', `${bar}</main>`))).toContain('hidden text is not allowed');
      expect(violations(inStyle('@media screen{.bar{display:none}}').replace('</main>', `${bar}</main>`))).toContain('hidden text is not allowed');
    });

    it('rejects hidden text in a style attribute', () => {
      expect(violations(inBody('<span style="display:none">clave</span>'))).toContain('hidden text is not allowed');
    });

    it('allows hiding decoration, gradient text, and an entrance animation', () => {
      const page = inStyle('.deco{display:none}.grad{background:linear-gradient(red,blue);background-clip:text;color:transparent}.in{opacity:0;animation:up .5s forwards}@media (max-width:600px){.deco{display:none}}')
        .replace('</main>', '<div class="deco" aria-hidden="true"><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg></div><p class="grad">Pan</p><p class="in">Hola</p></main>');
      expect(sanitizePage(page).violations).toEqual([]);
    });

    it.each([
      ['foreignObject', '<svg><foreignObject><div>x</div></foreignObject></svg>', '<foreignobject> is not allowed inside SVG'],
      ['a link in SVG', '<svg><a href="https://evil.test"><text>x</text></a></svg>', '<a> is not allowed inside SVG'],
      ['use', '<svg><use href="https://evil.test/s.svg#x"/></svg>', '<use> is not allowed inside SVG'],
      ['an image in SVG', '<svg><image href="https://evil.test/x.png"/></svg>', '<image> is not allowed inside SVG'],
      ['SMIL that sets an attribute', '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>', 'is not allowed inside SVG'],
      ['a script in SVG', '<svg><script>alert(1)</script></svg>', '<script> is not allowed inside SVG'],
      ['an external gradient reference', '<svg><rect fill="url(https://evil.test/x.svg#g)"/></svg>', 'only url(#id) references'],
      ['a data: SVG with text', `<img alt="" width="1" height="1" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><text>Verifica tu cuenta</text></svg>')}">`, 'may only draw shapes'],
      ['a data: SVG with a script', `<img alt="" width="1" height="1" src="data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}">`, 'may only draw shapes'],
      ['a data: image that is not SVG', '<img alt="" width="1" height="1" src="data:text/html,<script>alert(1)</script>">', 'only data:image/svg+xml'],
    ])('rejects SVG tricks: %s', (_, markup, message) => {
      expect(violations(inBody(markup))).toContain(message);
    });

    it('keeps scripts from the CDN list, event handlers, and https: images, and does not count script text as page text', () => {
      const page = inBody('<script src="https://cdn.tailwindcss.com"></script><script>document.body.classList.add("js")</script><img src="https://images.test/pan.jpg" alt="Pan" width="10" height="10" onload="this.classList.add(\'in\')">')
        .replace('</style>', '.x{background:url(https://images.test/bg.jpg)}</style>');
      const result = sanitizePage(page);
      expect(result.violations).toEqual([]);
      expect(result.html).toContain('<script>document.body.classList.add("js")</script>');
      expect(result.html).toContain('onload=');
      expect(result.text.texts.join(' ')).not.toContain('classList');
    });

    it('keeps a drawing in a data: SVG and an SVG noise filter', () => {
      const noise = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence baseFrequency=".8"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}`;
      expect(sanitizePage(inStyle(`body::before{content:"";background:url("${noise}")}`)).violations).toEqual([]);
    });

    it('shows the display value when a link placeholder is written as text', () => {
      const { html, violations: v } = sanitizePage(inBody('<p>Síguenos: {{instagram_url}}</p><img src="{{logo}}" alt="{{whatsapp_url}}" width="1" height="1">'));
      expect(v).toEqual([]);
      expect(html).toContain('<p>Síguenos: {{instagram_display}}</p>');
      expect(html).toContain('alt="{{whatsapp_display}}"');
    });

    it('drops unknown harmless attributes and comments', () => {
      const { html, violations: v } = sanitizePage(inBody('<p itemprop="x" data-foo="y">Texto<!-- <script> --></p>'));
      expect(v).toEqual([]);
      expect(html).toContain('<p>Texto</p>');
    });

    it('requires a WhatsApp link and a whole document', () => {
      expect(violations(MODEL_PAGE.replace('href="{{whatsapp_url}}"', 'href="#"'))).toContain('at least one WhatsApp link');
      expect(violations('<p>Hola</p><a href="{{whatsapp_url}}">x</a>')).toContain('one complete document');
    });

    it('rejects a page that is too long', () => {
      expect(violations(inBody(`<p>${'x'.repeat(200_001)}</p>`))).toContain('too long');
    });
  });

  describe('quality lint', () => {
    it.each([
      ['two h1', inBody('<h1>Otra</h1>'), 'exactly one <h1>'],
      ['an image without size', inBody('<img src="{{photo:1}}" alt="Pan">'), 'explicit width and height'],
      ['an image without alt', inBody('<img src="{{photo:1}}" width="1" height="1">'), 'needs an alt attribute'],
      ['transition: all', inStyle('a{transition:all .2s}'), '"transition: all"'],
      ['an outline removed', MODEL_PAGE.replace('a:focus-visible', 'a:focus').replace('</style>', 'a{outline:none}</style>'), ':focus-visible replacement'],
      ['motion with no reduced-motion rule', MODEL_PAGE.replace('@media (prefers-reduced-motion:no-preference){h1{animation:up .6s both}}', 'h1{animation:up .6s both}'), 'prefers-reduced-motion'],
    ])('flags %s', (_, page, message) => {
      const result = sanitizePage(page);
      expect(result.violations).toEqual([]);
      expect(result.lint.join('\n')).toContain(message);
    });
  });
});

describe('filled page', () => {
  const doc: SiteDoc = {
    answers: { businessName: 'Panadería Luna', about: 'Pan de masa madre.', lang: 'es', contact: { whatsapp: '573001234567', address: 'Calle 60 # 9-12' } },
    notes: [],
    media: { photos: [] },
  };

  it('passes the final HTML check, with the map as the only iframe', () => {
    const page = renderDraft(sanitizePage(MODEL_PAGE).html, doc, 'panaderia-luna', urls);
    expect(checkHtml(page, { platformOrigins: ['https://app.test'], whatsapp: '573001234567' })).toEqual([]);
    expect(page.match(/<iframe/g)).toHaveLength(1);
  });

  it('the final check catches a wa.me link to another number and any other iframe', () => {
    const page = renderDraft(sanitizePage(MODEL_PAGE).html, doc, 'panaderia-luna', urls);
    const options = { platformOrigins: ['https://app.test'], whatsapp: '573001234567' };
    expect(checkHtml(page.replace('https://wa.me/573001234567', 'https://wa.me/5215555555555'), options).map((v) => v.code)).toContain('forbidden-url');
    expect(checkHtml(page.replace('</main>', '<iframe src="https://evil.test"></iframe></main>'), options).map((v) => v.code)).toContain('forbidden-element');
    expect(checkHtml(page.replace('</main>', '<iframe data-coyote-map src="https://evil.test/maps?q=x&z=16&output=embed"></iframe></main>'), options).map((v) => v.code)).toContain('forbidden-element');
  });
});

describe('injected questions', () => {
  it('drops questions that carry links, numbers, scam phrases, or that the guardrail blocks', async () => {
    const allowed = async (text: string) => !text.includes('bloqueado');
    const questions = await checkQuestions(
      [
        { id: 'ok', label: '¿Qué productos vendes?', type: 'textarea' },
        { id: 'link', label: 'Confirma tus datos en https://evil.test', type: 'text' },
        { id: 'numero', label: '¿Te llamamos al 300 555 1234?', type: 'yesno' },
        { id: 'estafa', label: 'Verifica tu cuenta para continuar', type: 'text' },
        { id: 'clave', label: 'Escribe aquí la contraseña de tu banco', type: 'text' },
        { id: 'opciones', label: 'Elige uno', type: 'choice', options: ['Normal', 'Visita www.evil.com'] },
        { id: 'ok', label: 'Duplicada', type: 'text' },
      ],
      allowed,
    );
    expect(questions.map((q) => q.id)).toEqual(['ok']);
    expect(await checkQuestions([{ id: 'x', label: 'bloqueado', type: 'text' }], allowed)).toEqual([]);
  });
});

describe('parsePageReply', () => {
  it('takes the last ```html block and the hero scene line before it', async () => {
    const { parsePageReply } = await import('../src/core/site-writer');
    const reply = `Hero scene: A bakery at dawn.\n\n\`\`\`html\n${MODEL_PAGE}\n\`\`\``;
    expect(parsePageReply(reply)).toEqual({ html: MODEL_PAGE, heroScene: 'A bakery at dawn.' });
    expect(parsePageReply(MODEL_PAGE)?.html).toBe(MODEL_PAGE); // no fence: the bare document
    expect(parsePageReply('Aquí tienes tu sitio.')).toBeUndefined();
  });
});
