import { describe, expect, it } from 'vitest';
import { createUrls, urlConfigFromEnv } from '../src/core/urls';

describe('domainless mode', () => {
  const urls = createUrls({
    mode: 'domainless',
    appBaseUrl: 'https://dapp.cloudfront.test/',
    apiBaseUrl: 'https://abc.execute-api.test',
    sitesBaseUrl: 'https://dsites.cloudfront.test',
  });

  it('serves sites and previews by path', () => {
    expect(urls.siteUrl('luna')).toBe('https://dsites.cloudfront.test/luna/');
    expect(urls.previewUrl('job1')).toBe('https://dsites.cloudfront.test/_preview/job1/');
    expect(urls.siteOrigin('luna')).toBe('https://dsites.cloudfront.test');
    expect(urls.previewOrigin).toBe('https://dsites.cloudfront.test');
  });

  it('builds app links without a double slash', () => {
    expect(urls.appUrl).toBe('https://dapp.cloudfront.test');
    expect(urls.reportUrl('luna')).toBe('https://dapp.cloudfront.test/reportar?sitio=luna');
    expect(urls.miSitioUrl('a/b')).toBe('https://dapp.cloudfront.test/mi-sitio#token=a%2Fb');
  });
});

describe('domain mode', () => {
  it('uses subdomains', () => {
    const urls = createUrls({ mode: 'domain', domainName: 'brand.test', sitesDomainName: 'sites.test' });
    expect(urls.appUrl).toBe('https://app.brand.test');
    expect(urls.apiUrl).toBe('https://api.brand.test');
    expect(urls.siteUrl('luna')).toBe('https://luna.sites.test/');
    expect(urls.previewUrl('job1')).toBe('https://preview.sites.test/job1/');
    expect(urls.siteOrigin('luna')).toBe('https://luna.sites.test');
    expect(urls.previewOrigin).toBe('https://preview.sites.test');
  });
});

describe('urlConfigFromEnv', () => {
  it('prefers domain mode when both domains are set', () => {
    expect(urlConfigFromEnv({ DOMAIN_NAME: 'brand.test', SITES_DOMAIN_NAME: 'sites.test' }).mode).toBe('domain');
  });
  it('falls back to domainless', () => {
    expect(urlConfigFromEnv({ APP_BASE_URL: 'https://a.test', API_BASE_URL: 'https://b.test', SITES_BASE_URL: 'https://c.test' }).mode).toBe('domainless');
  });
  it('throws when nothing is configured', () => {
    expect(() => urlConfigFromEnv({})).toThrow();
  });
});
