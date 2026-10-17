import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { porkbun } from '../aws/porkbun';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { checkDomains, domainPage, registerDomain, type DomainDeps } from '../core/domains';
import { authenticate } from '../core/owner';
import { json, parseBody, perIpLimit } from './http';

const stores = createStores(storeConfigFromEnv());
const ssm = new SSMClient({});

/** The `./coyote.sh domain-register` switch, read per request. Unreadable or unset: closed. */
async function registerOpen(): Promise<boolean> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: process.env.DOMAIN_REGISTER_PARAMETER }))).Parameter?.Value === 'on';
  } catch (error) {
    console.error('domain-register switch unreadable, registering is closed', error);
    return false;
  }
}

const sqs = new SQSClient({});

export const deps: DomainDeps = {
  stores,
  registrar: porkbun,
  registerOpen,
  // The hosting setup (handlers/hosting-setup.ts) starts once a domain is registered.
  async queueHosting(slug, domain) {
    await sqs.send(new SendMessageCommand({ QueueUrl: process.env.HOSTING_SETUPS_QUEUE_URL, MessageBody: JSON.stringify({ slug, domain }) }));
  },
  now: Date.now,
};

// GET /me/domain · GET /me/domain/check?q= · POST /me/domain. Same credential as Mi sitio.
export const handler: APIGatewayProxyHandlerV2 = perIpLimit(stores, async (event) => {
  const site = await authenticate(event.headers.authorization, deps);
  if (site === 'rate_limited') return json(429, { error: 'rate_limited' });
  if (!site) return json(401, { error: 'unauthorized' });

  switch (event.routeKey) {
    case 'GET /me/domain':
      return json(200, await domainPage(site, deps));
    case 'GET /me/domain/check': {
      const result = await checkDomains(site, event.queryStringParameters?.q ?? '', deps);
      if (result.status === 200) return json(200, { quotes: result.quotes });
      return json(result.status, { error: result.status === 400 ? 'invalid' : 'rate_limited' });
    }
    case 'POST /me/domain': {
      const result = await registerDomain(site, parseBody(event.body, event.isBase64Encoded), deps);
      switch (result.status) {
        case 201:
          return json(201, { domain: result.domain });
        case 400:
          return json(400, { error: 'invalid' });
        case 402:
          return json(402, { error: 'needs_plan' });
        case 403:
          return json(403, { error: 'closed' });
        case 409:
          return json(409, { error: result.error });
        case 429:
          return json(429, { error: 'rate_limited' });
        default:
          return json(502, { error: 'registrar' });
      }
    }
    default:
      return json(404, { error: 'not_found' });
  }
});
