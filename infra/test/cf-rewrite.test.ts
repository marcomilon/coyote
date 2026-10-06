import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Result = { uri?: string; statusCode?: number; headers?: Record<string, { value: string }> };

function load(file: string, replacements: Record<string, string> = {}) {
  let source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(replacements)) source = source.replace(key, value);
  const handler = new Function(`${source}; return handler;`)() as (event: unknown) => Result;
  return (uri: string, host = 'd111.cloudfront.test') => handler({ request: { uri, headers: { host: { value: host } } } });
}

const DRAFT = '0123456789abcdef0123456789abcdef';

describe('sites rewrite, domainless mode', () => {
  const run = load('cf-rewrite.js', { __SITES_HOST__: '', __APP_URL__: 'https://app.test' });

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

  it('sends the root to the app', () => {
    expect(run('/')).toMatchObject({ statusCode: 302, headers: { location: { value: 'https://app.test' } } });
  });
});

describe('sites rewrite, domain mode', () => {
  const run = load('cf-rewrite.js', { __SITES_HOST__: 'sites.test', __APP_URL__: 'https://app.brand.test' });

  it('maps the draft host to the draft folder', () => {
    expect(run(`/${DRAFT}/`, 'draft.sites.test').uri).toBe(`/_draft/${DRAFT}/index.html`);
    expect(run(`/${DRAFT}/assets/logo.png`, 'Draft.Sites.Test').uri).toBe(`/_draft/${DRAFT}/assets/logo.png`);
    expect(run(`/${DRAFT}`, 'draft.sites.test')).toMatchObject({ statusCode: 301, headers: { location: { value: `/${DRAFT}/` } } });
    expect(run('/', 'draft.sites.test').statusCode).toBe(404);
    expect(run('/_src/luna/x.html', 'draft.sites.test').statusCode).toBe(404);
  });

  it('sends the apex and www to the app', () => {
    expect(run('/', 'sites.test').statusCode).toBe(302);
    expect(run('/x', 'www.sites.test').statusCode).toBe(302);
  });

  it('serves no published site for now, and rejects other hosts', () => {
    for (const host of ['panaderia-luna.sites.test', '_uploads.sites.test', 'a.b.sites.test', 'evil.test', 'xsites.test', 'd111.cloudfront.test']) {
      expect(run('/', host).statusCode, host).toBe(404);
    }
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
