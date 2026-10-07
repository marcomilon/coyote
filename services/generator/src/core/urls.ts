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
      /** An address verified in SES (CDK context `senderEmail`). Without it no email is sent. */
      senderEmail?: string;
    }
  | {
      mode: 'domain';
      domainName: string;
      sitesDomainName: string;
    };

export interface Urls {
  appUrl: string;
  apiUrl: string;
  /** Always ends with "/". */
  siteUrl(slug: string): string;
  /** A private draft (the magic-link owner's view). Always ends with "/". */
  draftUrl(draftId: string): string;
  /** Origin a site's visitors send (contact-form Origin check). */
  siteOrigin(slug: string): string;
  /** Origin of the draft iframe (app CSP `frame-src`). */
  draftOrigin: string;
  miSitioUrl(token: string): string;
  /** "Mis sitios" signed in with a sign-in link, optionally with one site selected. */
  mySitesUrl(login: string, lang: 'es' | 'pt', slug?: string): string;
  /** The From address of our emails, or undefined when none is set up. */
  mailFrom?: string;
  reportUrl(slug: string): string;
  privacyUrl: string;
  /** The platform links every generated page carries, in the page's language. */
  /** The links in every page's platform footer: our home page, report, and privacy, in the page's language. */
  pageLinks(slug: string, lang: 'es' | 'pt'): { homeUrl: string; reportUrl: string; privacyUrl: string };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function createUrls(config: UrlConfig): Urls {
  if (config.mode === 'domain') {
    const sitesHost = config.sitesDomainName;
    const siteOrigin = (slug: string) => `https://${slug}.${sitesHost}`;
    const draftOrigin = `https://draft.${sitesHost}`;
    return withAppUrls({
      appUrl: `https://www.${config.domainName}`, // the bare domain redirects here (cf-app-rewrite.js)
      apiUrl: `https://api.${config.domainName}`,
      siteOrigin,
      draftOrigin,
      siteUrl: (slug) => `${siteOrigin(slug)}/`,
      draftUrl: (draftId) => `${draftOrigin}/${draftId}/`,
      mailFrom: `no-reply@notify.${config.domainName}`,
    });
  }

  const sitesBase = trimSlash(config.sitesBaseUrl);
  const sitesOrigin = new URL(sitesBase).origin;
  return withAppUrls({
    appUrl: trimSlash(config.appBaseUrl),
    apiUrl: trimSlash(config.apiBaseUrl),
    siteOrigin: () => sitesOrigin,
    draftOrigin: sitesOrigin,
    siteUrl: (slug) => `${sitesBase}/${slug}/`,
    draftUrl: (draftId) => `${sitesBase}/_draft/${draftId}/`,
    mailFrom: config.senderEmail,
  });
}

function withAppUrls(base: Omit<Urls, 'miSitioUrl' | 'mySitesUrl' | 'reportUrl' | 'privacyUrl' | 'pageLinks'>): Urls {
  const sitio = (slug: string) => `?sitio=${encodeURIComponent(slug)}`;
  return {
    ...base,
    pageLinks: (slug, lang) =>
      lang === 'pt'
        ? { homeUrl: `${base.appUrl}/pt/`, reportUrl: `${base.appUrl}/pt/denunciar${sitio(slug)}`, privacyUrl: `${base.appUrl}/pt/privacidade` }
        : { homeUrl: `${base.appUrl}/`, reportUrl: `${base.appUrl}/reportar${sitio(slug)}`, privacyUrl: `${base.appUrl}/privacidad` },
    miSitioUrl: (token) => `${base.appUrl}/mi-sitio#token=${encodeURIComponent(token)}`,
    mySitesUrl: (login, lang, slug) =>
      `${base.appUrl}${lang === 'pt' ? '/pt/meus-sites' : '/mis-sitios'}#login=${encodeURIComponent(login)}${slug ? `&site=${encodeURIComponent(slug)}` : ''}`,
    reportUrl: (slug) => `${base.appUrl}/reportar?sitio=${encodeURIComponent(slug)}`,
    privacyUrl: `${base.appUrl}/privacidad`,
  };
}

/** Lambdas and scripts read the mode from env vars set by the CDK stack. */
export function urlConfigFromEnv(env: Record<string, string | undefined>): UrlConfig {
  const { DOMAIN_NAME, SITES_DOMAIN_NAME, APP_BASE_URL, API_BASE_URL, SITES_BASE_URL, SENDER_EMAIL } = env;
  if (DOMAIN_NAME && SITES_DOMAIN_NAME) {
    return { mode: 'domain', domainName: DOMAIN_NAME, sitesDomainName: SITES_DOMAIN_NAME };
  }
  if (APP_BASE_URL && API_BASE_URL && SITES_BASE_URL) {
    return { mode: 'domainless', appBaseUrl: APP_BASE_URL, apiBaseUrl: API_BASE_URL, sitesBaseUrl: SITES_BASE_URL, senderEmail: SENDER_EMAIL || undefined };
  }
  throw new Error('Set DOMAIN_NAME + SITES_DOMAIN_NAME, or APP_BASE_URL + API_BASE_URL + SITES_BASE_URL.');
}
