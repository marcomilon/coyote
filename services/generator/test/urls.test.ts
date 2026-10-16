import { describe, expect, it } from 'vitest';
import { createUrls, urlConfigFromEnv } from '../src/core/urls';

describe('domainless mode', () => {
  const urls = createUrls({
    mode: 'domainless',
    appBaseUrl: 'https://dapp.cloudfront.test/',
    apiBaseUrl: 'https://abc.execute-api.test',
    sitesBaseUrl: 'https://dsites.cloudfront.test',
  });

  it('serves examples and drafts by path', () => {
    expect(urls.exampleUrl('luna')).toBe('https://dsites.cloudfront.test/luna/');
    expect(urls.draftUrl('d1')).toBe('https://dsites.cloudfront.test/_draft/d1/');
    expect(urls.draftOrigin).toBe('https://dsites.cloudfront.test');
  });

  it('builds app links without a double slash', () => {
    expect(urls.appUrl).toBe('https://dapp.cloudfront.test');
    expect(urls.miSitioUrl('a/b')).toBe('https://dapp.cloudfront.test/mi-pagina-web#token=a%2Fb');
  });
});

describe('domain mode', () => {
  it('uses subdomains of the one domain', () => {
    const urls = createUrls({ mode: 'domain', domainName: 'brand.test' });
    expect(urls.appUrl).toBe('https://www.brand.test');
    expect(urls.apiUrl).toBe('https://api.brand.test');
    expect(urls.exampleUrl('luna')).toBe('https://luna.brand.test/');
    expect(urls.draftUrl('d1')).toBe('https://draft.brand.test/d1/');
    expect(urls.draftOrigin).toBe('https://draft.brand.test');
  });
});

describe('urlConfigFromEnv', () => {
  it('prefers domain mode when the domain is set', () => {
    expect(urlConfigFromEnv({ DOMAIN_NAME: 'brand.test', APP_BASE_URL: 'https://a.test', API_BASE_URL: 'https://b.test', SITES_BASE_URL: 'https://c.test' }).mode).toBe('domain');
  });
  it('falls back to domainless', () => {
    expect(urlConfigFromEnv({ APP_BASE_URL: 'https://a.test', API_BASE_URL: 'https://b.test', SITES_BASE_URL: 'https://c.test' }).mode).toBe('domainless');
  });
  it('throws when nothing is configured', () => {
    expect(() => urlConfigFromEnv({})).toThrow();
  });
});

