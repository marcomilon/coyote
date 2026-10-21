import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Result = { uri?: string; statusCode?: number; headers?: Record<string, { value: string }> };

function load(file: string, replacements: Record<string, string> = {}) {
  let source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(replacements)) source = source.replace(key, value);
  const handler = new Function(`${source}; return handler;`)() as (event: unknown) => Result;
  return (uri: string, host = 'd111.cloudfront.test', dest: string | null = 'iframe') =>
    handler({ request: { uri, headers: { host: { value: host }, ...(dest ? { 'sec-fetch-dest': { value: dest } } : {}) } } });
}

const DRAFT = '0123456789abcdef0123456789abcdef';

describe('sites rewrite, domainless mode', () => {
  const run = load('cf-rewrite.js', { __DOMAIN__: '', __APP_URL__: 'https://app.test', __EXAMPLES__: 'taller-ruiz,salon-luna' });

  it('serves drafts by path', () => {
    expect(run(`/_draft/${DRAFT}/`).uri).toBe(`/_draft/${DRAFT}/index.html`);
    expect(run(`/_draft/${DRAFT}/assets/hero.jpg`).uri).toBe(`/_draft/${DRAFT}/assets/hero.jpg`);
  });

  it('adds the trailing slash so relative assets resolve', () => {
    expect(run(`/_draft/${DRAFT}`)).toMatchObject({ statusCode: 301, headers: { location: { value: `/_draft/${DRAFT}/` } } });
  });

  it('serves no published site for now, and hides internal prefixes', () => {
    for (const uri of ['/panaderia-luna/', '/panaderia-luna', '/_draft/', '/_draft/short/', '/_src/luna/x.html', '/_media/luna/assets/logo.png', '/_uploads/job1/foto.jpg', '/_quarantine/x/index.html', '/_errors/404.html', '/_anything']) {
      expect(run(uri).statusCode, uri).toBe(404);
    }
  });

  it('serves drafts only inside a frame, not opened from a shared link', () => {
    expect(run(`/_draft/${DRAFT}/`, undefined, 'document').statusCode).toBe(404);
    expect(run(`/_draft/${DRAFT}`, undefined, 'document').statusCode).toBe(404);
    expect(run(`/_draft/${DRAFT}/`, undefined, null).statusCode).toBe(404);
    expect(run(`/_draft/${DRAFT}/assets/hero.jpg`, undefined, 'image').uri).toBe(`/_draft/${DRAFT}/assets/hero.jpg`);
  });

  it('sends the root to the app', () => {
    expect(run('/')).toMatchObject({ statusCode: 302, headers: { location: { value: 'https://app.test' } } });
  });

  it('serves the landing examples by path, opened like any page', () => {
    expect(run('/taller-ruiz/', undefined, 'document').uri).toBe('/_examples/taller-ruiz/index.html');
    expect(run('/salon-luna/assets/gen-1.jpg', undefined, 'image').uri).toBe('/_examples/salon-luna/assets/gen-1.jpg');
    expect(run('/taller-ruiz', undefined, 'document')).toMatchObject({ statusCode: 301, headers: { location: { value: '/taller-ruiz/' } } });
    expect(run('/_examples/taller-ruiz/index.html', undefined, 'document').statusCode).toBe(404);
  });
});

describe('sites rewrite, domain mode', () => {
  const run = load('cf-rewrite.js', { __DOMAIN__: 'brand.test', __APP_URL__: 'https://app.brand.test', __EXAMPLES__: 'taller-ruiz,salon-luna' });

  it('maps the draft host to the draft folder', () => {
    expect(run(`/${DRAFT}/`, 'draft.brand.test').uri).toBe(`/_draft/${DRAFT}/index.html`);
    expect(run(`/${DRAFT}/assets/logo.png`, 'Draft.Brand.Test').uri).toBe(`/_draft/${DRAFT}/assets/logo.png`);
    expect(run(`/${DRAFT}`, 'draft.brand.test')).toMatchObject({ statusCode: 301, headers: { location: { value: `/${DRAFT}/` } } });
    expect(run('/', 'draft.brand.test').statusCode).toBe(404);
    expect(run('/_src/luna/x.html', 'draft.brand.test').statusCode).toBe(404);
    expect(run(`/${DRAFT}/`, 'draft.brand.test', 'document').statusCode).toBe(404);
    expect(run(`/${DRAFT}/`, 'draft.brand.test', null).statusCode).toBe(404);
  });

  it('serves the landing examples on their own host, opened like any page', () => {
    expect(run('/', 'taller-ruiz.brand.test', 'document').uri).toBe('/_examples/taller-ruiz/index.html');
    expect(run('/assets/gen-1.jpg', 'Salon-Luna.Brand.Test', 'image').uri).toBe('/_examples/salon-luna/assets/gen-1.jpg');
    expect(run('/', 'taller-ruiz.brand.test', null).uri).toBe('/_examples/taller-ruiz/index.html');
  });

  it('serves no customer site, and rejects other hosts', () => {
    for (const host of ['panaderia-luna.brand.test', 'taller-ruiz.evil.test', 'x.taller-ruiz.brand.test', '.brand.test', '_uploads.brand.test', 'a.b.brand.test', 'evil.test', 'xbrand.test', 'brand.test', 'www.brand.test', 'd111.cloudfront.test']) {
      expect(run('/', host).statusCode, host).toBe(404);
    }
  });
});

describe('app rewrite', () => {
  const run = load('cf-app-rewrite.js', { __BARE_HOST__: '', __APP_URL__: '', __VOSEO__: 'AR,UY,PY' });

  it.each([
    ['/', '/index.html'],
    ['/pt/', '/pt/index.html'],
    ['/mi-pagina-web', '/mi-pagina-web/index.html'],
    ['/pt/privacidade', '/pt/privacidade/index.html'],
    ['/config.js', '/config.js'],
    ['/_astro/form.abc123.js', '/_astro/form.abc123.js'],
  ])('%s → %s', (uri, expected) => expect(run(uri).uri).toBe(expected));
});

describe('app rewrite, vos pages', () => {
  const handler = new Function(`${readFileSync(new URL('../lib/cf-app-rewrite.js', import.meta.url), 'utf8').replace('__BARE_HOST__', '').replace('__APP_URL__', '').replace('__VOSEO__', 'AR,UY,PY')}; return handler;`)() as (event: unknown) => Result;
  const run = (uri: string, country?: string, chosen?: string) =>
    handler({
      request: {
        uri,
        headers: { host: { value: 'www.brand.test' }, ...(country ? { 'cloudfront-viewer-country': { value: country } } : {}) },
        cookies: chosen ? { country: { value: chosen } } : {},
      },
    }).uri;

  it('serves the vos pages to visitors in Argentina, Uruguay and Paraguay', () => {
    expect(run('/', 'AR')).toBe('/vos/index.html');
    expect(run('/crear', 'UY')).toBe('/vos/crear/index.html');
    expect(run('/mi-pagina-web/', 'PY')).toBe('/vos/mi-pagina-web/index.html');
  });

  it('serves the tú pages elsewhere, or when the country is unknown', () => {
    expect(run('/crear', 'MX')).toBe('/crear/index.html');
    expect(run('/crear')).toBe('/crear/index.html');
  });

  it("follows the country chosen in the picker over the one CloudFront sees", () => {
    expect(run('/crear', 'MX', 'AR')).toBe('/vos/crear/index.html');
    expect(run('/crear', 'AR', 'PE')).toBe('/crear/index.html');
    expect(run('/crear', 'AR', 'nonsense')).toBe('/vos/crear/index.html');
  });

  it('leaves Portuguese pages, files and vos pages alone', () => {
    expect(run('/pt/', 'AR')).toBe('/pt/index.html');
    expect(run('/pt', 'AR')).toBe('/pt/index.html');
    expect(run('/config.js', 'AR')).toBe('/config.js');
    expect(run('/_astro/home.abc.css', 'AR')).toBe('/_astro/home.abc.css');
    expect(run('/vos/crear', 'AR')).toBe('/vos/crear/index.html');
  });
});

describe('app rewrite, domain mode', () => {
  const run = load('cf-app-rewrite.js', { __BARE_HOST__: 'brand.test', __APP_URL__: 'https://www.brand.test', __VOSEO__: 'AR,UY,PY' });
  const handler = new Function(`${readFileSync(new URL('../lib/cf-app-rewrite.js', import.meta.url), 'utf8').replace('__BARE_HOST__', 'brand.test').replace('__APP_URL__', 'https://www.brand.test').replace('__VOSEO__', 'AR,UY,PY')}; return handler;`)() as (event: unknown) => Result;

  it('sends the bare domain to www, keeping the path and the query', () => {
    expect(run('/mi-pagina-web', 'brand.test')).toMatchObject({ statusCode: 301, headers: { location: { value: 'https://www.brand.test/mi-pagina-web' } } });
    const withQuery = handler({ request: { uri: '/reportar', headers: { host: { value: 'Brand.test' } }, querystring: { sitio: { value: 'luna' } } } });
    expect(withQuery).toMatchObject({ statusCode: 301, headers: { location: { value: 'https://www.brand.test/reportar?sitio=luna' } } });
  });

  it('serves www as usual', () => {
    expect(run('/mi-pagina-web', 'www.brand.test').uri).toBe('/mi-pagina-web/index.html');
  });
});

describe('live sites', () => {
  const handler = new Function(`${readFileSync(new URL('../lib/cf-live.js', import.meta.url), 'utf8')}; return handler;`)() as (event: unknown) => Result;
  const run = (host: string, querystring = {}) => handler({ request: { uri: '/menu', headers: { host: { value: host } }, querystring } });

  it('sends the bare domain to www, keeping the path and the query', () => {
    expect(run('Luna.com')).toMatchObject({ statusCode: 301, headers: { location: { value: 'https://www.luna.com/menu' } } });
    expect(run('luna.com.ar', { a: { value: '1' } })).toMatchObject({ statusCode: 301, headers: { location: { value: 'https://www.luna.com.ar/menu?a=1' } } });
  });

  it('serves www as usual', () => {
    expect(run('www.luna.com').uri).toBe('/menu');
  });
});

describe('geo', () => {
  const handler = new Function(`${readFileSync(new URL('../lib/cf-geo.js', import.meta.url), 'utf8')}; return handler;`)() as (event: unknown) => Result & { body?: string };
  const run = (country?: string) => handler({ request: { uri: '/geo', headers: country === undefined ? {} : { 'cloudfront-viewer-country': { value: country } } } });

  it("answers with the visitor's country, never cached", () => {
    expect(run('CO')).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': { value: 'application/json' }, 'cache-control': { value: 'private, no-store' } },
      body: '{"country":"CO"}',
    });
  });

  it('answers null when CloudFront does not know', () => {
    for (const country of [undefined, '', 'XYZ', 'co', '<b>']) expect(run(country).body, String(country)).toBe('{"country":null}');
  });
});
