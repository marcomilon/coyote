import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { emitMetrics } from '../core/metrics';
import { reportSite } from '../core/report';
import { json, parseBody } from './http';

const stores = createStores(storeConfigFromEnv());
const sns = new SNSClient({});

// POST /report/{slug}
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = parseBody(event.body, event.isBase64Encoded) as { reason?: unknown } | undefined;
  const result = await reportSite(event.pathParameters?.slug ?? '', typeof body?.reason === 'string' ? body.reason : '', event.requestContext.http.sourceIp, {
    stores,
    ipSalt: process.env.IP_HASH_SALT ?? '',
    notify: async (subject, message) => {
      await sns.send(new PublishCommand({ TopicArn: process.env.ABUSE_TOPIC_ARN, Subject: subject.slice(0, 100), Message: message }));
    },
    now: Date.now,
  });
  if (result.status === 202 && result.counted) emitMetrics({ Reported: 1, ...(result.quarantined ? { Quarantined: 1 } : {}) });
  // The reporter always gets the same answer, whether or not the report counted.
  return result.status === 202 ? json(202, { status: 'received' }) : json(result.status, { error: result.status === 404 ? 'not_found' : 'rate_limited' });
};
