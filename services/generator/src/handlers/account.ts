import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { sesSendEmail } from '../aws/mail';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { accountView, checkSession, requestLogin, startSession, type AccountDeps } from '../core/account';
import { createUrls, urlConfigFromEnv } from '../core/urls';
import { json, parseBody } from './http';

const urls = createUrls(urlConfigFromEnv(process.env));
const deps: AccountDeps = {
  stores: createStores(storeConfigFromEnv()),
  urls,
  sendEmail: sesSendEmail(urls.mailFrom),
  now: Date.now,
  ipSalt: process.env.IP_HASH_SALT ?? '',
};

// POST /account/login · POST /account/session · GET /account ("Mis sitios").
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = () => parseBody(event.body, event.isBase64Encoded);
  switch (event.routeKey) {
    case 'POST /account/login': {
      const { status } = await requestLogin(body(), event.requestContext.http.sourceIp, deps);
      return json(status, status === 202 ? { status: 'sent' } : { error: status === 400 ? 'invalid' : 'unavailable' });
    }
    case 'POST /account/session': {
      const result = await startSession(body(), deps);
      return result.status === 200 ? json(200, { token: result.token, expiresAt: result.expiresAt }) : json(result.status, { error: 'invalid_link' });
    }
    case 'GET /account': {
      const id = await checkSession(event.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '', deps);
      return id ? json(200, await accountView(id, deps)) : json(401, { error: 'unauthorized' });
    }
    default:
      return json(404, { error: 'not_found' });
  }
};
