import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { SNSEvent } from 'aws-lambda';
import { suppress } from '../aws/mail';
import { suppressionsOf } from '../core/mail-events';
import { emailId } from '../core/token';

const ssm = new SSMClient({});

/** A CloudWatch alarm calling the Lambda directly. */
interface AlarmEvent {
  source: 'aws.cloudwatch';
  alarmData: { alarmName: string; state: { value: string } };
}

// SES bounce and complaint events (through SNS) → suppression; the bounce/complaint rate alarms → email off.
export const handler = async (event: SNSEvent | AlarmEvent): Promise<void> => {
  if ('source' in event && event.source === 'aws.cloudwatch') {
    if (event.alarmData.state.value !== 'ALARM') return;
    await ssm.send(new PutParameterCommand({ Name: process.env.EMAIL_PARAMETER, Value: 'off', Overwrite: true }));
    console.warn(`email paused by ${event.alarmData.alarmName}. Check, then ./coyote.sh email on`);
    return;
  }
  for (const record of (event as SNSEvent).Records ?? []) {
    const found = suppressionsOf(record.Sns.Message);
    if (!found) continue;
    for (const email of found.emails) {
      await suppress(process.env.MAIL_SUPPRESSION_TABLE!, emailId(email), found.reason, Date.now());
      console.warn(`suppressed an address after a ${found.reason}`);
    }
  }
};
