/**
 * The only module that knows whether the stack runs with or without custom domains
 * (PLAN.md "Domains"). CSP, CORS, and Origin checks must derive from here.
 */
export type UrlConfig =
  | {
      mode: 'domainless';
      /** CloudFront URL of the app distribution. */
      appBaseUrl: string;
      /** Default execute-api URL. */
      apiBaseUrl: string;
      /** CloudFront URL of the sites distribution; sites are path-based under it. */
      sitesBaseUrl: string;
    }
  | {
      mode: 'domain';
      envName: 'dev' | 'prod';
      domainName: string;
      sitesDomainName: string;
    };

export interface Urls {
  appUrl: string;
  apiUrl: string;
  /** Always ends with "/". */
  siteUrl(slug: string): string;
  /** Always ends with "/". */
  previewUrl(jobId: string): string;
  /** Origin a site's visitors send (contact-form Origin check). */
  siteOrigin(slug: string): string;
  /** Origin of the preview iframe (app CSP `frame-src`). */
  previewOrigin: string;
  miSitioUrl(token: string): string;
  reportUrl(slug: string): string;
  privacyUrl: string;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function createUrls(config: UrlConfig): Urls {
  if (config.mode === 'domain') {
    const dev = config.envName === 'dev';
    const sitesHost = dev ? `dev.${config.sitesDomainName}` : config.sitesDomainName;
    const siteOrigin = (slug: string) => `https://${slug}.${sitesHost}`;
    const previewOrigin = `https://preview.${sitesHost}`;
    return withAppUrls({
      appUrl: `https://${dev ? 'app-dev' : 'app'}.${config.domainName}`,
      apiUrl: `https://${dev ? 'api-dev' : 'api'}.${config.domainName}`,
      siteOrigin,
      previewOrigin,
      siteUrl: (slug) => `${siteOrigin(slug)}/`,
      previewUrl: (jobId) => `${previewOrigin}/${jobId}/`,
    });
  }

  const sitesBase = trimSlash(config.sitesBaseUrl);
  const sitesOrigin = new URL(sitesBase).origin;
  return withAppUrls({
    appUrl: trimSlash(config.appBaseUrl),
    apiUrl: trimSlash(config.apiBaseUrl),
    siteOrigin: () => sitesOrigin,
    previewOrigin: sitesOrigin,
    siteUrl: (slug) => `${sitesBase}/${slug}/`,
    previewUrl: (jobId) => `${sitesBase}/_preview/${jobId}/`,
  });
}

function withAppUrls(base: Omit<Urls, 'miSitioUrl' | 'reportUrl' | 'privacyUrl'>): Urls {
  return {
    ...base,
    miSitioUrl: (token) => `${base.appUrl}/mi-sitio#token=${encodeURIComponent(token)}`,
    reportUrl: (slug) => `${base.appUrl}/reportar?sitio=${encodeURIComponent(slug)}`,
    privacyUrl: `${base.appUrl}/privacidad`,
  };
}

/** Lambdas and scripts read the mode from env vars set by the CDK stack. */
export function urlConfigFromEnv(env: Record<string, string | undefined>): UrlConfig {
  const { DOMAIN_NAME, SITES_DOMAIN_NAME, ENV_NAME, APP_BASE_URL, API_BASE_URL, SITES_BASE_URL } = env;
  if (DOMAIN_NAME && SITES_DOMAIN_NAME) {
    return {
      mode: 'domain',
      envName: ENV_NAME === 'prod' ? 'prod' : 'dev',
      domainName: DOMAIN_NAME,
      sitesDomainName: SITES_DOMAIN_NAME,
    };
  }
  if (APP_BASE_URL && API_BASE_URL && SITES_BASE_URL) {
    return { mode: 'domainless', appBaseUrl: APP_BASE_URL, apiBaseUrl: API_BASE_URL, sitesBaseUrl: SITES_BASE_URL };
  }
  throw new Error('Set DOMAIN_NAME + SITES_DOMAIN_NAME, or APP_BASE_URL + API_BASE_URL + SITES_BASE_URL.');
}
