import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

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
