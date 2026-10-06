import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Account, AccountToken, ChatMessage, Job, SiteRecord, Stores } from '../core/jobs';

export interface StoreConfig {
  jobsTable: string;
  sitesTable: string;
  rateLimitTable: string;
  blocklistTable: string;
  chatTable: string;
  accountsTable: string;
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
    chatTable: need('CHAT_TABLE'),
    accountsTable: need('ACCOUNTS_TABLE'),
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

  const getObject = async (key: string) => {
    try {
      return (await s3.send(new GetObjectCommand({ Bucket: config.sitesBucket, Key: key }))).Body;
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  };

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
            // Only a bare claim of this job: never a site with a draft, or somebody else's claim.
            ConditionExpression: 'jobId = :jobId AND #status = :claimed AND attribute_not_exists(currentDraftId)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':jobId': jobId, ':claimed': 'claimed' },
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
            UpdateExpression: 'SET #a = :redacted REMOVE #n, #i, #q, #t, #e',
            ExpressionAttributeNames: { '#a': 'answers', '#n': 'notes', '#i': 'instruction', '#q': 'questions', '#t': 'ownerToken', '#e': 'ownerEmail' },
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
      await this.invalidatePaths([`/${slug}`, `/${slug}/*`]);
    },

    async invalidatePaths(paths) {
      if (!config.sitesDistributionId) throw new Error('SITES_DISTRIBUTION_ID is not set for this function');
      await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: config.sitesDistributionId,
          InvalidationBatch: { CallerReference: `${paths[0]}-${Date.now()}`, Paths: { Quantity: paths.length, Items: paths } },
        }),
      );
    },

    async transitionJob(jobId, from, patch) {
      const expression = setExpression(patch);
      try {
        await db.send(
          new UpdateCommand({
            TableName: config.jobsTable,
            Key: { jobId },
            ...expression,
            ConditionExpression: '#from = :from',
            ExpressionAttributeNames: { ...expression.ExpressionAttributeNames, '#from': 'status' },
            ExpressionAttributeValues: { ...expression.ExpressionAttributeValues, ':from': from },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async takeOwnerToken(jobId) {
      try {
        const { Attributes } = await db.send(
          new UpdateCommand({
            TableName: config.jobsTable,
            Key: { jobId },
            UpdateExpression: 'REMOVE ownerToken',
            ConditionExpression: 'attribute_exists(ownerToken)',
            ReturnValues: 'ALL_OLD',
          }),
        );
        return Attributes?.ownerToken as string | undefined;
      } catch (error) {
        if (isConditionFailure(error)) return undefined;
        throw error;
      }
    },

    async putPrivate(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: config.sitesBucket, Key: key, Body: body, ContentType: contentType }));
    },

    async getText(key) {
      return (await getObject(key))?.transformToString('utf-8');
    },

    async getBytes(key) {
      return (await getObject(key))?.transformToByteArray();
    },

    async putPage(key, page, cacheControl = 'public, max-age=300') {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.sitesBucket,
          Key: key,
          Body: page,
          ContentType: 'text/html; charset=utf-8',
          CacheControl: cacheControl,
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

    async putChat(message) {
      await db.send(new PutCommand({ TableName: config.chatTable, Item: message }));
    },

    async updateChat(slug, at, patch) {
      await db.send(new UpdateCommand({ TableName: config.chatTable, Key: { slug, at }, ConditionExpression: 'attribute_exists(slug)', ...setExpression(patch) }));
    },

    async listChat(slug, after, limit) {
      const { Items } = await db.send(
        new QueryCommand({
          TableName: config.chatTable,
          KeyConditionExpression: 'slug = :slug AND #at > :after',
          ExpressionAttributeNames: { '#at': 'at' },
          ExpressionAttributeValues: { ':slug': slug, ':after': after },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return ((Items ?? []) as ChatMessage[]).reverse();
    },

    async deleteChat(slug) {
      let start: Record<string, unknown> | undefined;
      do {
        const page = await db.send(
          new QueryCommand({
            TableName: config.chatTable,
            KeyConditionExpression: 'slug = :slug',
            ExpressionAttributeValues: { ':slug': slug },
            ProjectionExpression: 'slug, #at',
            ExpressionAttributeNames: { '#at': 'at' },
            ExclusiveStartKey: start,
          }),
        );
        const keys = page.Items ?? [];
        for (let i = 0; i < keys.length; i += 25) {
          const batch = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
          await db.send(new BatchWriteCommand({ RequestItems: { [config.chatTable]: batch } }));
        }
        start = page.LastEvaluatedKey;
      } while (start);
    },

    async linkAccountSite(emailId, email, lang, site) {
      const pk = `email#${emailId}`;
      await db.send(
        new UpdateCommand({
          TableName: config.accountsTable,
          Key: { pk, sk: 'profile' },
          UpdateExpression: 'SET email = :email, lang = if_not_exists(lang, :lang)',
          ExpressionAttributeValues: { ':email': email, ':lang': lang },
        }),
      );
      await db.send(new PutCommand({ TableName: config.accountsTable, Item: { pk, sk: `site#${site.slug}`, ...site } }));
    },

    async getAccount(emailId) {
      const { Items = [] } = await db.send(
        new QueryCommand({ TableName: config.accountsTable, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `email#${emailId}` } }),
      );
      const profile = Items.find((item) => item.sk === 'profile');
      if (!profile) return undefined;
      const sites = Items.filter((item) => String(item.sk).startsWith('site#')).map(({ slug, businessName, createdAt }) => ({ slug, businessName, createdAt }));
      return { email: profile.email, lang: profile.lang, sites } as Account;
    },

    async unlinkAccountSite(emailId, slug) {
      const pk = `email#${emailId}`;
      await db.send(new DeleteCommand({ TableName: config.accountsTable, Key: { pk, sk: `site#${slug}` } }));
      const account = await this.getAccount(emailId);
      if (account && account.sites.length === 0) await db.send(new DeleteCommand({ TableName: config.accountsTable, Key: { pk, sk: 'profile' } }));
    },

    async putAccountToken({ kind, id, ...token }) {
      await db.send(new PutCommand({ TableName: config.accountsTable, Item: { pk: `${kind}#${id}`, sk: '-', ...token, ttl: Math.ceil(token.expiresAt / 1000) } }));
    },

    async getAccountToken(kind, id) {
      const { Item } = await db.send(new GetCommand({ TableName: config.accountsTable, Key: { pk: `${kind}#${id}`, sk: '-' } }));
      return Item ? ({ kind, id, emailId: Item.emailId, secretHash: Item.secretHash, expiresAt: Item.expiresAt } as AccountToken) : undefined;
    },

    async takeAccountToken(kind, id) {
      try {
        const { Attributes } = await db.send(
          new DeleteCommand({ TableName: config.accountsTable, Key: { pk: `${kind}#${id}`, sk: '-' }, ConditionExpression: 'attribute_exists(pk)', ReturnValues: 'ALL_OLD' }),
        );
        return Attributes ? ({ kind, id, emailId: Attributes.emailId, secretHash: Attributes.secretHash, expiresAt: Attributes.expiresAt } as AccountToken) : undefined;
      } catch (error) {
        if (isConditionFailure(error)) return undefined;
        throw error;
      }
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
