import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Announce } from '../core/notices';

/** Admin notices to the `SiteNotices` topic. Undefined when the Lambda has no topic (nothing is sent). */
export function snsAnnounce(topicArn: string | undefined): Announce | undefined {
  if (!topicArn) return undefined;
  const sns = new SNSClient({});
  return async (subject, message) => {
    await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
  };
}
