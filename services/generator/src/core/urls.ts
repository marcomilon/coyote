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
    };

export interface Urls {
  appUrl: string;
  apiUrl: string;
  /** One of the landing page's example sites (examples.ts), the only public pages on our domain. Always ends with "/". */
  exampleUrl(slug: string): string;
  /** A private draft (the magic-link owner's view). Always ends with "/". */
  draftUrl(draftId: string): string;
  /** Origin of the draft iframe (app CSP `frame-src`). */
  draftOrigin: string;
  miSitioUrl(token: string): string;
  /** "Mis sitios" signed in with a sign-in link, optionally with one site selected. */
  mySitesUrl(login: string, lang: 'es' | 'pt', slug?: string): string;
  /** The From address of our emails, or undefined when none is set up. */
  mailFrom?: string;
  /** Where owners write to us (a paused account), or undefined with no domain (inbound mail needs one). */
  supportEmail?: string;
  /** Our name as owners see it (the domain), or undefined with no domain. */
  brand?: string;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function createUrls(config: UrlConfig): Urls {
  if (config.mode === 'domain') {
    // Customer pages are never public here: drafts show only inside the app, and owners publish on their own domain.
    const draftOrigin = `https://draft.${config.domainName}`;
    return withAppUrls({
      appUrl: `https://www.${config.domainName}`, // the bare domain redirects here (cf-app-rewrite.js)
      apiUrl: `https://api.${config.domainName}`,
      draftOrigin,
      exampleUrl: (slug) => `https://${slug}.${config.domainName}/`,
      draftUrl: (draftId) => `${draftOrigin}/${draftId}/`,
      mailFrom: `no-reply@${config.domainName}`,
      supportEmail: `soporte@${config.domainName}`,
      brand: config.domainName,
    });
  }

  const sitesBase = trimSlash(config.sitesBaseUrl);
  const sitesOrigin = new URL(sitesBase).origin;
  return withAppUrls({
    appUrl: trimSlash(config.appBaseUrl),
    apiUrl: trimSlash(config.apiBaseUrl),
    draftOrigin: sitesOrigin,
    exampleUrl: (slug) => `${sitesBase}/${slug}/`,
    draftUrl: (draftId) => `${sitesBase}/_draft/${draftId}/`,
    mailFrom: config.senderEmail,
  });
}

function withAppUrls(base: Omit<Urls, 'miSitioUrl' | 'mySitesUrl'>): Urls {
  return {
    ...base,
    miSitioUrl: (token) => `${base.appUrl}/mi-pagina-web#token=${encodeURIComponent(token)}`,
    mySitesUrl: (login, lang, slug) =>
      `${base.appUrl}${lang === 'pt' ? '/pt/meus-sites' : '/mis-paginas-web'}#login=${encodeURIComponent(login)}${slug ? `&site=${encodeURIComponent(slug)}` : ''}`,
  };
}

/** Lambdas and scripts read the mode from env vars set by the CDK stack. */
export function urlConfigFromEnv(env: Record<string, string | undefined>): UrlConfig {
  const { DOMAIN_NAME, APP_BASE_URL, API_BASE_URL, SITES_BASE_URL, SENDER_EMAIL } = env;
  if (DOMAIN_NAME) return { mode: 'domain', domainName: DOMAIN_NAME };
  if (APP_BASE_URL && API_BASE_URL && SITES_BASE_URL) {
    return { mode: 'domainless', appBaseUrl: APP_BASE_URL, apiBaseUrl: API_BASE_URL, sitesBaseUrl: SITES_BASE_URL, senderEmail: SENDER_EMAIL || undefined };
  }
  throw new Error('Set DOMAIN_NAME, or APP_BASE_URL + API_BASE_URL + SITES_BASE_URL.');
}

/** A published site, on its owner's own domain (hosting.ts). */
export const liveUrl = (domain: string) => `https://${domain}/`;
