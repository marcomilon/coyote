import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Stores } from '../core/jobs';
import { emitMetrics } from '../core/metrics';
import { withinMinuteLimit } from '../core/ratelimit';

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function parseBody(body: string | undefined, isBase64Encoded: boolean | undefined): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
  } catch {
    return undefined;
  }
}

/** Wraps an API handler with the per-IP minute limit (ratelimit.ts): a flood gets 429 before any work. */
export function perIpLimit(stores: Pick<Stores, 'hitRateLimit'>, handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    if (!(await withinMinuteLimit(stores, event.requestContext.http.sourceIp, process.env.IP_HASH_SALT ?? '', Date.now()))) {
      emitMetrics({ RateLimited: 1 });
      return json(429, { error: 'rate_limited' });
    }
    return handler(event);
  };
}
