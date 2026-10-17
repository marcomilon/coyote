import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { porkbunDns } from '../aws/porkbun';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { tenants } from '../aws/tenants';
import { runHostingSetup, type HostingDeps } from '../core/hosting';
import { emitMetrics } from '../core/metrics';

const deps: HostingDeps = { stores: createStores(storeConfigFromEnv()), dns: porkbunDns, tenants, routingEndpoint: process.env.LIVE_ROUTING_ENDPOINT ?? '', now: Date.now };

// The hosting-setups queue (one message per registered domain, from core/domains.ts). A step that has to wait (DNS,
// the certificate) throws and the message comes back after the visibility timeout; after 24 tries (about 2 hours) it
// goes to the dead-letter queue, whose alarm tells us. A step that can't succeed alarms at once (HostingFailed).
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const { slug } = JSON.parse(record.body) as { slug: string; domain: string };
      const outcome = await runHostingSetup(slug, deps);
      if (outcome === 'failed') emitMetrics({ HostingFailed: 1 });
      if (outcome === 'live') emitMetrics({ Published: 1 });
      console.log(JSON.stringify({ hosting: record.body, outcome }));
    } catch (error) {
      console.log(JSON.stringify({ hosting: record.body, retry: String(error) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
