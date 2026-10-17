import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { runDomainOrder } from '../core/domains';
import { emitMetrics } from '../core/metrics';
import { deps } from './domains';

// The domain-orders queue (one message per paid plan, from handlers/payments.ts). A thrown order comes back after the
// visibility timeout; after 6 tries it goes to the dead-letter queue, whose alarm tells us. A refusal retrying can't
// fix is kept on the site's order and alarms at once (DomainOrderFailed).
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const { slug } = JSON.parse(record.body) as { slug: string; domain: string };
      const outcome = await runDomainOrder(slug, deps);
      if (outcome === 'failed') emitMetrics({ DomainOrderFailed: 1 });
      console.log(JSON.stringify({ domainOrder: record.body, outcome }));
    } catch (error) {
      console.error('domain order will be retried', record.body, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
