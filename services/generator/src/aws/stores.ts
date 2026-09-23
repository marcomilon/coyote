import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Job, SiteRecord, Stores } from '../core/jobs';

export interface StoreConfig {
  jobsTable: string;
  sitesTable: string;
  rateLimitTable: string;
  blocklistTable: string;
  sitesBucket: string;
  /** Unset in Lambdas that never change a published site. */
  sitesDistributionId?: string;
}

export function storeConfigFromEnv(env: Record<string, string | undefined> = process.env): StoreConfig {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`missing env var ${name}`);
    return value;
  };
  return {
    jobsTable: need('JOBS_TABLE'),
    sitesTable: need('SITES_TABLE'),
    rateLimitTable: need('RATE_LIMIT_TABLE'),
    blocklistTable: need('BLOCKLIST_TABLE'),
    sitesBucket: need('SITES_BUCKET'),
    sitesDistributionId: env.SITES_DISTRIBUTION_ID,
  };
}

const isConditionFailure = (error: unknown) => error instanceof ConditionalCheckFailedException;

/** Builds "SET #a = :a, #b = :b" for the defined fields of a patch. */
function setExpression(patch: Record<string, unknown>) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return {
    UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], i) => [`#f${i}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
  };
}

export function createStores(config: StoreConfig): Stores {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({});
  const cloudfront = new CloudFrontClient({});

  return {
    async hitRateLimit(key, max, ttl) {
      try {
        await db.send(
          new UpdateCommand({
            TableName: config.rateLimitTable,
            Key: { ip: key },
            UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :one',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
            ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': ttl },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async isBlocked(slug) {
      const { Item } = await db.send(new GetCommand({ TableName: config.blocklistTable, Key: { slug } }));
      return Item !== undefined;
    },

    async block(slug) {
      await db.send(new PutCommand({ TableName: config.blocklistTable, Item: { slug, blockedAt: Date.now() } }));
    },

    async putOnce(key, ttl) {
      try {
        await db.send(new PutCommand({ TableName: config.rateLimitTable, Item: { ip: key, ttl }, ConditionExpression: 'attribute_not_exists(ip)' }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async increment(key, ttl) {
      const { Attributes } = await db.send(
        new UpdateCommand({
          TableName: config.rateLimitTable,
          Key: { ip: key },
          UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :one',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(Attributes?.count ?? 0);
    },

    async claimSlug(site) {
      try {
        await db.send(
          new PutCommand({ TableName: config.sitesTable, Item: site, ConditionExpression: 'attribute_not_exists(slug)' }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async releaseSlug(slug, jobId) {
      try {
        await db.send(
          new DeleteCommand({
            TableName: config.sitesTable,
            Key: { slug },
            // Never delete a published site or somebody else's claim.
            ConditionExpression: 'jobId = :jobId AND #status <> :published',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':jobId': jobId, ':published': 'published' },
          }),
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    },

    async saveSite({ slug, ...fields }) {
      await db.send(new UpdateCommand({ TableName: config.sitesTable, Key: { slug }, ...setExpression(fields) }));
    },

    async getSite(slug) {
      const { Item } = await db.send(new GetCommand({ TableName: config.sitesTable, Key: { slug } }));
      return Item as SiteRecord | undefined;
    },

    async deleteSite(slug) {
      await db.send(new DeleteCommand({ TableName: config.sitesTable, Key: { slug } }));
    },

    async redactJob(jobId) {
      try {
        await db.send(
          new UpdateCommand({
            TableName: config.jobsTable,
            Key: { jobId },
            ConditionExpression: 'attribute_exists(jobId)',
            UpdateExpression: 'SET #a = :redacted REMOVE #r',
            ExpressionAttributeNames: { '#a': 'answers', '#r': 'result' },
            ExpressionAttributeValues: { ':redacted': { deleted: true } },
          }),
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    },

    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: config.sitesBucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
        if (keys.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: config.sitesBucket, Delete: { Objects: keys } }));
        token = page.NextContinuationToken;
      } while (token);
    },

    async putJob(job) {
      await db.send(new PutCommand({ TableName: config.jobsTable, Item: job }));
    },

    async getJob(jobId) {
      const { Item } = await db.send(new GetCommand({ TableName: config.jobsTable, Key: { jobId } }));
      return Item as Job | undefined;
    },

    async updateJob(jobId, patch) {
      await db.send(
        new UpdateCommand({
          TableName: config.jobsTable,
          Key: { jobId },
          ConditionExpression: 'attribute_exists(jobId)',
          ...setExpression(patch),
        }),
      );
    },

    async invalidateSite(slug) {
      if (!config.sitesDistributionId) throw new Error('SITES_DISTRIBUTION_ID is not set for this function');
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: config.sitesDistributionId,
          InvalidationBatch: { CallerReference: `${slug}-${Date.now()}`, Paths: { Quantity: 2, Items: [`/${slug}`, `/${slug}/*`] } },
        }),
      );
    },

    async putPage(key, page) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.sitesBucket,
          Key: key,
          Body: page,
          ContentType: 'text/html; charset=utf-8',
          CacheControl: 'public, max-age=300',
        }),
      );
    },

    async putAsset(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({ Bucket: config.sitesBucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=86400' }),
      );
    },

    async listKeys(prefix) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: config.sitesBucket, Prefix: prefix, MaxKeys: 50 }));
      return (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
    },

    async copyObject(from, to, contentType) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: config.sitesBucket,
          CopySource: encodeURI(`${config.sitesBucket}/${from}`),
          Key: to,
          ContentType: contentType,
          CacheControl: 'public, max-age=86400',
          MetadataDirective: 'REPLACE',
        }),
      );
    },

    async copyPrefix(from, to) {
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: config.sitesBucket, Prefix: from, ContinuationToken: token }));
        for (const object of page.Contents ?? []) {
          if (!object.Key) continue;
          await s3.send(
            new CopyObjectCommand({
              Bucket: config.sitesBucket,
              CopySource: encodeURI(`${config.sitesBucket}/${object.Key}`),
              Key: to + object.Key.slice(from.length),
            }),
          );
        }
        token = page.NextContinuationToken;
      } while (token);
    },
  };
}
