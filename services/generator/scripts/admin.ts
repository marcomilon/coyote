/**
 * Admin commands against the deployed stack. Run them through ./coyote.sh, which sets the AWS profile:
 *   unpublish <slug>    take a site down for good and blocklist the slug
 *   restore <slug>      bring a quarantined site back
 *   abuse-report        who did what in the last 24 h
 *   refill-all          finish every site's current draft again (after a page-check or domain change); no model call
 *   domains             the domains registered for owners (Mi sitio → Dominio)
 *   domain-order <slug> the domain a paid plan ordered; with `resend`, clears its failure and queues it again
 *   hosting <slug>      the site's hosting setup on its domain (step, tenant, certificate); `resend` queues it again
 *   domain-attach <slug> <domain>  an invited customer: links a domain already in our Porkbun account to a site (no
 *                       purchase; our own plan, no Paddle) and starts the hosting setup, as a paid registration would
 *   domain-detach <slug>           undoes domain-attach (tenant, our DNS records, the live copy, our plan); run it
 *                       again while CloudFront is still disabling the tenant
 *   free-draft <email>  give an email its free draft and its 3 free designs back (support: a second business; testing)
 *   usage <email>       the email's model calls by tier (paid/free) and their cost: all time and this month
 *   unfreeze <email>    lift the freeze an account got for too many refused requests (freeze.ts)
 *   delete-all-sites    delete every site (drafts, photos, chat, jobs), the domain records and every counter; keeps the
 *                       landing examples and accounts. Sandbox only: ./coyote.sh asks for a typed confirmation
 */
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { porkbun, porkbunDns } from '../src/aws/porkbun';
import { tenants } from '../src/aws/tenants';
import { attachDomain } from '../src/core/domains';
import { INVITED, isInvited } from '../src/core/plan';
import { removeHosting, type HostingDeps } from '../src/core/hosting';
import { RetryLater } from '../src/core/retry';
import { BatchWriteCommand, DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';
import { createStores } from '../src/aws/stores';
import { livePrefix, refillDraft, takeDownLive } from '../src/core/drafts';
import { deleteSite } from '../src/core/owner';
import { usageOf, type UsageCount } from '../src/core/email-usage';
import { modelTier } from '../src/core/models';
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
// aws/tenants.ts reads these, as in the HostingSetup Lambda.
process.env.LIVE_DISTRIBUTION_ID ??= outputs.LiveDistributionId;
process.env.LIVE_CONNECTION_GROUP_ID ??= outputs.LiveConnectionGroupId;
const sqs = new SQSClient({});
const queueHosting = (slug: string, domain: string) => {
  if (!outputs.HostingSetupsQueueUrl) throw new Error('infra/cdk-outputs.json has no HostingSetupsQueueUrl. Run ./coyote.sh deploy first.');
  return sqs.send(new SendMessageCommand({ QueueUrl: outputs.HostingSetupsQueueUrl, MessageBody: JSON.stringify({ slug, domain }) }));
};
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
    await stores.deletePrefix(livePrefix(s));
    await stores.deletePrefix(`_quarantine/${s}/`);
    await stores.block(s);
    if (await stores.getSite(s)) await stores.saveSite({ slug: s, status: 'blocked' });
    await stores.invalidateSite(s);
    console.log(`${s}: pages deleted, slug blocklisted.`);
    break;
  }
  case 'restore': {
    const s = needSlug();
    await stores.copyPrefix(`_quarantine/${s}/`, livePrefix(s));
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
    // Per model, this month and all time.
    const models = Object.entries(all.models).sort(([, a], [, b]) => b.microUsd - a.microUsd || b.calls - a.calls);
    if (models.length) console.log(`  by model     ${monthName.padStart(17)}            all time`);
    for (const [id, m] of models) {
      const now = month.models[id] ?? { calls: 0, microUsd: 0 };
      const cell = (c: { calls: number; microUsd: number }) => `${String(c.calls).padStart(5)} calls $${(c.microUsd / 1_000_000).toFixed(2).padStart(6)}`;
      console.log(`    ${id}\n      ${modelTier(id).padEnd(9)}${cell(now)}  ${cell(m)}`);
    }
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
    for (const prefix of ['_draft/', '_src/', '_media/', '_uploads/', '_live/', '_quarantine/']) await stores.deletePrefix(prefix);
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
  case 'domain-order': {
    const site = slug ? await stores.getSite(slug) : undefined;
    if (!site) throw new Error(`no site ${slug}`);
    const order = site.domainOrder;
    console.log(`  plan ${site.billing?.status ?? 'none'} · domain ${site.domain ?? '-'} · order ${order ? `${order.domain}${order.failed ? ` (failed: ${order.failed})` : ' (queued)'}` : '-'}`);
    if (rest[0] !== 'resend') break;
    if (!order) throw new Error('no order to resend');
    if (!outputs.DomainOrdersQueueUrl) throw new Error('infra/cdk-outputs.json has no DomainOrdersQueueUrl. Run ./coyote.sh deploy first.');
    await stores.saveSite({ slug: site.slug, domainOrder: { domain: order.domain, at: order.at } });
    await new SQSClient({}).send(new SendMessageCommand({ QueueUrl: outputs.DomainOrdersQueueUrl, MessageBody: JSON.stringify({ slug: site.slug, domain: order.domain }) }));
    console.log(`Queued ${order.domain} again; ./coyote.sh domain-order ${site.slug} shows the outcome.`);
    break;
  }
  case 'hosting': {
    const site = slug ? await stores.getSite(slug) : undefined;
    const record = site?.domain ? await stores.getDomain(site.domain) : undefined;
    if (!site || !record) throw new Error(`${slug}: no site with a domain`);
    const h = record.hosting;
    const tenant = h?.tenantId ? await tenants.get(h.tenantId) : undefined;
    const cert = h?.tenantId ? await tenants.certificate(h.tenantId) : undefined;
    console.log(`  ${record.domain} · ${record.status} · site ${site.status} · plan ${site.billing?.status ?? 'none'}`);
    console.log(`  hosting ${h ? `${h.step}${h.failed ? ` (failed: ${h.failed})` : ''} since ${new Date(h.at).toISOString()}` : '-'}`);
    if (tenant) {
      const attached = cert?.arn && tenant.certificateArn === cert.arn ? 'attached' : 'not attached';
      console.log(`  tenant ${tenant.id} · certificate ${cert?.status ?? '-'} (${attached}) · ${tenant.domains.map((d) => `${d.domain} ${d.status}`).join(', ')}`);
    }
    console.log(`  DNS → ${outputs.LiveRoutingEndpoint ?? '?'} (ALIAS @, CNAME www, TXT _cf-challenge)`);
    if (rest[0] !== 'resend') break;
    if (h?.failed) await stores.saveDomain({ domain: record.domain, hosting: { ...h, failed: undefined, at: Date.now() } });
    await queueHosting(site.slug, record.domain);
    console.log(`Queued again; ./coyote.sh hosting ${site.slug} shows the progress.`);
    break;
  }
  case 'domain-attach': {
    const domain = rest[0]?.trim().toLowerCase();
    const site = slug ? await stores.getSite(slug) : undefined;
    if (!site || !domain) throw new Error('usage: domain-attach <slug> <domain>');
    // Paying publishes, so a site without a plan gets ours (an invited customer, no Paddle), as the webhook saves a paid one.
    const now = Date.now();
    const invited = !['active', 'past_due'].includes(site.billing?.status ?? '');
    if (invited) await stores.saveBilling(site.slug, { subscriptionId: INVITED, customerId: INVITED, status: 'active', updatedAt: now });
    // The rest is what a paid registration does (domains.ts): the record, auto-renew off, the expiry, hosting queued.
    const result = await attachDomain(site, domain, { stores, registrar: porkbun, queueHosting: async (s, d) => void (await queueHosting(s, d)), now: Date.now });
    if (result.status !== 201) {
      if (invited) await stores.saveBilling(site.slug, { subscriptionId: INVITED, customerId: INVITED, status: 'canceled', updatedAt: Date.now() });
      throw new Error(
        result.status === 404 ? `${domain} is not in our Porkbun account (or its API access is off)`
        : result.status === 400 ? `${domain}: not a domain we offer`
        : 'error' in result && result.error === 'has_domain' ? `${slug} already has ${site.domain}`
        : `${domain} is already linked to a site`,
      );
    }
    console.log(`${domain} linked to ${site.slug}${invited ? ' with our plan (invited)' : ''}: ${result.domain.status}, hosting setup queued. ./coyote.sh hosting ${site.slug} shows the progress.`);
    break;
  }
  case 'domain-detach': {
    const site = slug ? await stores.getSite(slug) : undefined;
    const record = site?.domain ? await stores.getDomain(site.domain) : undefined;
    if (!site || !record) throw new Error(`${slug}: no site with a domain`);
    if (!outputs.LiveRoutingEndpoint) throw new Error('infra/cdk-outputs.json has no LiveRoutingEndpoint. Run ./coyote.sh deploy first.');
    const deps: HostingDeps = { stores, dns: porkbunDns, tenants, routingEndpoint: outputs.LiveRoutingEndpoint, now: Date.now };
    await takeDownLive(site.slug, stores);
    try {
      await removeHosting(record, deps);
    } catch (error) {
      if (!(error instanceof RetryLater)) throw error;
      console.log(`CloudFront is disabling the tenant. Run ./coyote.sh domain-detach ${site.slug} again in a few minutes.`);
      break;
    }
    await stores.deletePrefix(livePrefix(site.slug)); // the "no disponible" page takeDownLive left
    await stores.releaseDomain(record.domain, site.slug);
    if (isInvited(site)) await stores.saveBilling(site.slug, { subscriptionId: INVITED, customerId: INVITED, status: 'canceled', updatedAt: Date.now() });
    console.log(`${record.domain} detached from ${site.slug}: tenant deleted, our DNS records removed, the site is a draft again.`);
    break;
  }
  default:
    console.error('commands: unpublish <slug> | restore <slug> | abuse-report | refill-all | domains | domain-order <slug> [resend] | hosting <slug> [resend] | domain-attach <slug> <domain> | domain-detach <slug> | free-draft <email> | usage <email> | unfreeze <email>');
    process.exit(1);
}
