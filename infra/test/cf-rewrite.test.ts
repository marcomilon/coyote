import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Result = { uri?: string; statusCode?: number; headers?: Record<string, { value: string }> };

function load(file: string, replacements: Record<string, string> = {}) {
  let source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(replacements)) source = source.replace(key, value);
  const handler = new Function(`${source}; return handler;`)() as (event: unknown) => Result;
  return (uri: string, host = 'd111.cloudfront.test') => handler({ request: { uri, headers: { host: { value: host } } } });
}

describe('sites rewrite, domainless mode', () => {
  const run = load('cf-rewrite.js', { __SITES_HOST__: '', __APP_URL__: 'https://app.test' });

  it('serves sites by path', () => {
    expect(run('/panaderia-luna/').uri).toBe('/panaderia-luna/index.html');
    expect(run('/panaderia-luna/assets/logo.webp').uri).toBe('/panaderia-luna/assets/logo.webp');
  });

  it('adds the trailing slash so relative assets resolve', () => {
    expect(run('/panaderia-luna')).toMatchObject({ statusCode: 301, headers: { location: { value: '/panaderia-luna/' } } });
    expect(run('/_preview/job1')).toMatchObject({ statusCode: 301, headers: { location: { value: '/_preview/job1/' } } });
  });

  it('serves previews', () => {
    expect(run('/_preview/job1/').uri).toBe('/_preview/job1/index.html');
  });

  it('hides internal prefixes', () => {
    for (const uri of ['/_uploads/job1/foto.jpg', '/_quarantine/x/index.html', '/_errors/404.html', '/_anything']) {
      expect(run(uri).statusCode, uri).toBe(404);
    }
  });

  it('sends the root to the app', () => {
    expect(run('/')).toMatchObject({ statusCode: 302, headers: { location: { value: 'https://app.test' } } });
  });
});

describe('sites rewrite, domain mode', () => {
  const run = load('cf-rewrite.js', { __SITES_HOST__: 'sites.test', __APP_URL__: 'https://app.brand.test' });

  it('maps the subdomain to the site folder', () => {
    expect(run('/', 'panaderia-luna.sites.test').uri).toBe('/panaderia-luna/index.html');
    expect(run('/assets/logo.webp', 'Panaderia-Luna.sites.test').uri).toBe('/panaderia-luna/assets/logo.webp');
  });

  it('maps the preview host', () => {
    expect(run('/job1/', 'preview.sites.test').uri).toBe('/_preview/job1/index.html');
    expect(run('/', 'preview.sites.test').statusCode).toBe(404);
  });

  it('sends the apex and www to the app', () => {
    expect(run('/', 'sites.test').statusCode).toBe(302);
    expect(run('/x', 'www.sites.test').statusCode).toBe(302);
  });

  it('rejects hosts that are not a slug', () => {
    for (const host of ['_uploads.sites.test', 'a.b.sites.test', 'evil.test', 'xsites.test', 'd111.cloudfront.test', '-x.sites.test']) {
      expect(run('/', host).statusCode, host).toBe(404);
    }
  });

  it('cannot reach internal prefixes through a slug host', () => {
    expect(run('/_uploads/job1/foto.jpg', 'luna.sites.test').uri).toBe('/luna/_uploads/job1/foto.jpg');
  });
});

describe('app rewrite', () => {
  const run = load('cf-app-rewrite.js');

  it.each([
    ['/', '/index.html'],
    ['/pt/', '/pt/index.html'],
    ['/mi-sitio', '/mi-sitio/index.html'],
    ['/pt/privacidade', '/pt/privacidade/index.html'],
    ['/config.js', '/config.js'],
    ['/_astro/form.abc123.js', '/_astro/form.abc123.js'],
  ])('%s → %s', (uri, expected) => expect(run(uri).uri).toBe(expected));
});
