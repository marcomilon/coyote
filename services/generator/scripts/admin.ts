/**
 * Admin commands against the deployed stack. Run them through ./coyote.sh, which sets the AWS profile:
 *   unpublish <slug>    take a site down for good and blocklist the slug
 *   restore <slug>      bring a quarantined site back
 *   abuse-report        who did what in the last 24 h
 *   refill-all          finish every site's current draft again (after a page-check or domain change); no model call
 *   domains             the domains registered for owners (Mi sitio → Dominio)
 *   free-draft <email>  give an email its free draft and its 3 free designs back (support: a second business; testing)
 *   usage <email>       the email's model calls by tier (paid/free) and their cost: all time and this month
 *   unfreeze <email>    lift the freeze an account got for too many refused requests (freeze.ts)
 *   delete-all-sites    delete every site (drafts, photos, chat, jobs), the domain records and every counter; keeps the
 *                       landing examples and accounts. Sandbox only: ./coyote.sh asks for a typed confirmation
 */
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';
import { createStores } from '../src/aws/stores';
import { refillDraft } from '../src/core/drafts';
import { deleteSite } from '../src/core/owner';
import { usageOf, type UsageCount } from '../src/core/email-usage';
import { returnFreeDraft } from '../src/core/free-draft';
import { isFrozen, unfreeze } from '../src/core/freeze';
import { addBoughtDesigns, boughtDesigns, PAID_WRITES_PER_EMAIL, paidWritesLeft, resetPaidWrites } from '../src/core/paid-writes';
import { emailId } from '../src/core/token';
import type { DomainRecord, Job, SiteRecord } from '../src/core/jobs';
import { createUrls } from '../src/core/urls';

const outputs = JSON.parse(readFileSync(new URL('../../../infra/cdk-outputs.json', import.meta.url), 'utf8')).Coyote as Record<string, string>;
const config = {
  jobsTable: outputs.JobsTableName!,
  sitesTable: outputs.SitesTableName!,
  rateLimitTable: outputs.RateLimitTableName!,
  blocklistTable: outputs.BlocklistTableName!,
  chatTable: outputs.ChatTableName!,
  accountsTable: outputs.AccountsTableName!,
  domainsTable: outputs.DomainsTableName!,
  sitesBucket: outputs.SitesBucketName!,
  sitesDistributionId: outputs.SitesDistributionId!,
};
if (Object.values(config).some((value) => !value)) throw new Error('infra/cdk-outputs.json is missing values. Run ./coyote.sh deploy first.');

process.env.AWS_REGION ??= 'us-east-1';
const stores = createStores(config);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Domain mode would read the two domain names from the CDK context instead.
const urls = createUrls({ mode: 'domainless', appBaseUrl: outputs.AppUrl!, apiBaseUrl: outputs.ApiUrl!, sitesBaseUrl: outputs.SitesBaseUrl! });

/** Deletes every row of a table, 25 at a time. Resolves to how many it deleted. */
async function emptyTable(table: string, key: string): Promise<number> {
  const keys = (await scan<Record<string, unknown>>(table)).map((item) => ({ [key]: item[key] }));
  for (let i = 0; i < keys.length; i += 25) {
    await db.send(new BatchWriteCommand({ RequestItems: { [table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }));
  }
  return keys.length;
}

async function scan<T>(table: string): Promise<T[]> {
  const items: T[] = [];
  for await (const page of paginateScan({ client: db }, { TableName: table })) items.push(...((page.Items ?? []) as T[]));
  return items;
}

const [command, slug, ...rest] = process.argv.slice(2);
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
    console.log(`${s}: restored.`);
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
    let failed = 0;
    for (const site of sites) {
      try {
        await refillDraft(site, { stores, urls });
        await stores.invalidatePaths([`/_draft/${site.currentDraftId}/*`]);
        console.log(`${site.slug}: refilled ${urls.draftUrl(site.currentDraftId!)}`);
      } catch (error) {
        failed++;
        console.error(`${site.slug}: FAILED (${error instanceof Error ? error.message.slice(0, 200) : error})`);
      }
    }
    console.log(`${sites.length - failed} site(s) done${failed ? `, ${failed} failed` : ''}.`);
    break;
  }
  case 'free-draft': {
    if (!slug?.includes('@')) throw new Error('usage: free-draft <email>');
    await returnFreeDraft(stores, slug);
    await resetPaidWrites(stores, slug);
    console.log(`${slug}: may create a new free draft, with ${PAID_WRITES_PER_EMAIL} free designs.`);
    break;
  }
  case 'usage': {
    if (!slug?.includes('@')) throw new Error('usage: usage <email>');
    const { all, month, monthName } = await usageOf(stores, emailId(slug), Date.now());
    // Only the email's hash is stored: known means it has an account (it made a site or signed in) or recorded calls.
    if (all.paid + all.free === 0 && !(await stores.getAccount(emailId(slug)))) {
      console.error(`${slug.trim().toLowerCase()}: unknown email (no account and no model calls recorded).`);
      process.exitCode = 1;
      break;
    }
    const line = (label: string, c: UsageCount) => `  ${label.padEnd(10)} ${String(c.paid).padStart(5)} paid  ${String(c.free).padStart(5)} free  $${(c.microUsd / 1_000_000).toFixed(2)}`;
    console.log(`${slug.trim().toLowerCase()}: model calls`);
    console.log(line('all time', all));
    console.log(line(monthName, month));
    console.log(`  designs left: ${await paidWritesLeft(stores, emailId(slug))} (${PAID_WRITES_PER_EMAIL} free + ${await boughtDesigns(stores, emailId(slug))} bought)`);
    if (await isFrozen(stores, emailId(slug))) console.log(`  FROZEN: too many refused requests (./coyote.sh unfreeze ${slug.trim().toLowerCase()})`);
    break;
  }
  case 'add-designs': {
    // Support or testing: designs given by hand, as if bought, without a payment. `usage` shows the count.
    const [n] = rest;
    if (!slug?.includes('@') || !/^[1-9]\d?$/.test(n ?? '')) throw new Error('usage: add-designs <email> <n>');
    const id = emailId(slug);
    await addBoughtDesigns(stores, id, `admin-${Date.now()}`, Number(n), Date.now());
    console.log(`${slug.trim().toLowerCase()}: ${await paidWritesLeft(stores, id)} designs left (${PAID_WRITES_PER_EMAIL} free + ${await boughtDesigns(stores, id)} bought)`);
    break;
  }
  case 'unfreeze': {
    if (!slug?.includes('@')) throw new Error('usage: unfreeze <email>');
    const was = await isFrozen(stores, emailId(slug));
    await unfreeze(stores, slug);
    console.log(`${slug.trim().toLowerCase()}: ${was ? 'unfrozen' : 'was not frozen'}; refusal count cleared.`);
    break;
  }
  case 'delete-all-sites': {
    const sites = await scan<SiteRecord>(config.sitesTable);
    let failed = 0;
    for (const site of sites) {
      try {
        await deleteSite(site, { stores });
        console.log(`${site.slug}: deleted`);
      } catch (error) {
        failed++;
        console.error(`${site.slug}: FAILED (${error instanceof Error ? error.message.slice(0, 200) : error})`);
      }
    }
    // What no site points to any more: old jobs, leftover files, counters, domain records.
    for (const prefix of ['_draft/', '_src/', '_media/', '_uploads/']) await stores.deletePrefix(prefix);
    const jobs = await emptyTable(config.jobsTable, 'jobId');
    const counters = await emptyTable(config.rateLimitTable, 'ip');
    const domains = await emptyTable(config.domainsTable, 'domain');
    console.log(`${sites.length - failed} site(s) deleted${failed ? `, ${failed} failed` : ''}; ${jobs} job(s), ${counters} counter(s), ${domains} domain record(s).`);
    break;
  }
  case 'domains': {
    const domains = (await scan<DomainRecord>(config.domainsTable)).sort((a, b) => a.createdAt - b.createdAt);
    for (const d of domains) {
      const expires = d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : '-';
      console.log(`  ${d.domain.padEnd(32)} ${d.status.padEnd(17)} ${d.slug.padEnd(24)} expires ${expires}  $${(d.priceCents / 100).toFixed(2)}`);
    }
    console.log(`${domains.length} domain(s).`);
    break;
  }
  default:
    console.error('commands: unpublish <slug> | restore <slug> | abuse-report | refill-all | domains | free-draft <email> | usage <email> | unfreeze <email>');
    process.exit(1);
}
