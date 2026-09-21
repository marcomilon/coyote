import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { createUploads } from '../core/uploads';
import { json, parseBody } from './http';

const config = storeConfigFromEnv();
const stores = createStores(config);
const s3 = new S3Client({});

// POST /uploads
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await createUploads(parseBody(event.body, event.isBase64Encoded), event.requestContext.http.sourceIp, {
    stores,
    ipSalt: process.env.IP_HASH_SALT ?? '',
    presign: async (key, contentType, maxBytes) => {
      // The signature covers the exact key, the content type, and the size limit.
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: config.sitesBucket,
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
        Fields: { 'Content-Type': contentType },
        Expires: 600,
      });
      return { url, fields };
    },
    now: Date.now,
    newId: randomUUID,
  });
  return result.status === 200 ? json(200, result) : json(result.status, { error: result.status === 429 ? 'rate_limited' : 'invalid' });
};
