import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SendEmail } from '../core/mail';

/** SES SendEmail from our address. Undefined when no sender is set up (the callers then send nothing). */
export function sesSendEmail(from: string | undefined): SendEmail | undefined {
  if (!from) return undefined;
  const ses = new SESv2Client({});
  return async ({ to, subject, text }) => {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: `Coyote <${from}>`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      }),
    );
  };
}
