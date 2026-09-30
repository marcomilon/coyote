/**
 * Admin commands against the deployed stack. Run them through ./coyote.sh, which sets the AWS profile:
 *   unpublish <slug>    take a site down for good and blocklist the slug
 *   restore <slug>      bring a quarantined site back
 *   abuse-report        who did what in the last 24 h
 *   refill-all          re-render every site's current draft (after a theme, renderer, or domain change); no model call
 */
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';
import { createStores } from '../src/aws/stores';
import { refillDraft } from '../src/core/drafts';
import type { Job, SiteRecord } from '../src/core/jobs';
import { createUrls } from '../src/core/urls';

const outputs = JSON.parse(readFileSync(new URL('../../../infra/cdk-outputs.json', import.meta.url), 'utf8')).Coyote as Record<string, string>;
const config = {
  jobsTable: outputs.JobsTableName!,
  sitesTable: outputs.SitesTableName!,
  rateLimitTable: outputs.RateLimitTableName!,
  blocklistTable: outputs.BlocklistTableName!,
  chatTable: outputs.ChatTableName!,
  accountsTable: outputs.AccountsTableName!,
  sitesBucket: outputs.SitesBucketName!,
  sitesDistributionId: outputs.SitesDistributionId!,
};
if (Object.values(config).some((value) => !value)) throw new Error('infra/cdk-outputs.json is missing values. Run ./coyote.sh deploy first.');

process.env.AWS_REGION ??= 'us-east-1';
const stores = createStores(config);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Domain mode would read the two domain names from the CDK context instead.
const urls = createUrls({ mode: 'domainless', appBaseUrl: outputs.AppUrl!, apiBaseUrl: outputs.ApiUrl!, sitesBaseUrl: outputs.SitesBaseUrl! });

async function scan<T>(table: string): Promise<T[]> {
  const items: T[] = [];
  for await (const page of paginateScan({ client: db }, { TableName: table })) items.push(...((page.Items ?? []) as T[]));
  return items;
}

const [command, slug] = process.argv.slice(2);
const needSlug = () => {
  if (!slug) throw new Error(`usage: ${command} <slug>`);
  return slug;
};

switch (command) {
  case 'unpublish': {
    const s = needSlug();
    await stores.deletePrefix(`${s}/`);
    await stores.deletePrefix(`_quarantine/${s}/`);
    await stores.block(s);
    if (await stores.getSite(s)) await stores.saveSite({ slug: s, status: 'blocked' });
    await stores.invalidateSite(s);
    console.log(`${s}: pages deleted, slug blocklisted.`);
    break;
  }
  case 'restore': {
    const s = needSlug();
    await stores.copyPrefix(`_quarantine/${s}/`, `${s}/`);
    await stores.deletePrefix(`_quarantine/${s}/`);
    await stores.saveSite({ slug: s, status: 'published' });
    await stores.invalidateSite(s);
    console.log(`${s}: back online at ${urls.siteUrl(s)}`);
    break;
  }
  case 'abuse-report': {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const jobs = (await scan<Job>(config.jobsTable)).filter((job) => job.createdAt >= since);
    const byIp = new Map<string, Job[]>();
    for (const job of jobs) byIp.set(job.ipHash, [...(byIp.get(job.ipHash) ?? []), job]);
    console.log(`Last 24 h: ${jobs.length} requests from ${byIp.size} visitors.\n`);
    console.log('Busiest visitors (hashed IP, requests, outcomes):');
    for (const [ip, list] of [...byIp].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
      const outcomes = list.reduce<Record<string, number>>((acc, job) => ({ ...acc, [job.status]: (acc[job.status] ?? 0) + 1 }), {});
      console.log(`  ${ip.slice(0, 12)}…  ${String(list.length).padStart(3)}  ${JSON.stringify(outcomes)}`);
    }
    console.log('\nRejected:');
    for (const job of jobs.filter((j) => j.status === 'REJECTED')) {
      const name = 'businessName' in job.answers ? job.answers.businessName : '(deleted)';
      console.log(`  ${job.rejectedBy}/${job.rejectDetail?.slice(0, 40)}  ${name}  [${job.ipHash.slice(0, 12)}…]`);
    }
    console.log('\nNewest drafts (look at them):');
    for (const job of jobs.filter((j) => j.status === 'DONE' && j.draftUrl).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)) {
      console.log(`  ${job.kind ?? 'create'}  ${job.slug}  ${job.draftUrl}  [${job.ipHash.slice(0, 12)}…]`);
    }
    break;
  }
  case 'refill-all': {
    const sites = (await scan<SiteRecord>(config.sitesTable)).filter((site) => site.currentDraftId);
    for (const site of sites) {
      await refillDraft(site, { stores, urls });
      await stores.invalidatePaths([`/_draft/${site.currentDraftId}/*`]);
      console.log(`${site.slug}: refilled ${urls.draftUrl(site.currentDraftId!)}`);
    }
    console.log(`${sites.length} site(s) done.`);
    break;
  }
  default:
    console.error('commands: unpublish <slug> | restore <slug> | abuse-report | refill-all');
    process.exit(1);
}
