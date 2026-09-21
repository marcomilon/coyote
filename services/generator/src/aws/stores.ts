import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Job, SiteRecord, Stores } from '../core/jobs';

export interface StoreConfig {
  jobsTable: string;
  sitesTable: string;
  rateLimitTable: string;
  blocklistTable: string;
  sitesBucket: string;
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

    async saveSite({ slug, ...fields }: SiteRecord) {
      await db.send(new UpdateCommand({ TableName: config.sitesTable, Key: { slug }, ...setExpression(fields) }));
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
