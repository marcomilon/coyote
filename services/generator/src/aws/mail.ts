import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SendEmail } from '../core/mail';
import { guardedSend, type MailGuard, type SuppressReason } from '../core/mail-events';

/** The `email` switch is read at most this often per container, so a pause applies within a minute. */
const SWITCH_TTL_MS = 60_000;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The suppression table (MAIL_SUPPRESSION_TABLE) and the `email` switch (EMAIL_PARAMETER). */
export function mailGuard(env: Record<string, string | undefined> = process.env): MailGuard {
  const ssm = new SSMClient({});
  let state: { on: boolean; at: number } | undefined;
  return {
    async sendingOn() {
      if (!env.EMAIL_PARAMETER) return true;
      const now = Date.now();
      if (state && now - state.at < SWITCH_TTL_MS) return state.on;
      let on = true;
      try {
        on = (await ssm.send(new GetParameterCommand({ Name: env.EMAIL_PARAMETER }))).Parameter?.Value !== 'off';
      } catch (error) {
        console.error(`${env.EMAIL_PARAMETER} unreadable, email on`, error);
      }
      state = { on, at: now };
      return on;
    },
    async isSuppressed(emailId) {
      if (!env.MAIL_SUPPRESSION_TABLE) return false;
      return Boolean((await db.send(new GetCommand({ TableName: env.MAIL_SUPPRESSION_TABLE, Key: { emailId } }))).Item);
    },
  };
}

export async function suppress(table: string, emailId: string, reason: SuppressReason, at: number): Promise<void> {
  await db.send(new PutCommand({ TableName: table, Item: { emailId, reason, at } }));
}

/**
 * SES SendEmail from our address, skipping suppressed addresses and everything while the `email` switch is off. The
 * identity's default configuration set publishes the bounces and complaints. Undefined when no sender is set up (the callers then send nothing).
 */
export function sesSendEmail(from: string | undefined, env: Record<string, string | undefined> = process.env): SendEmail | undefined {
  if (!from) return undefined;
  const ses = new SESv2Client({});
  return guardedSend(async ({ to, subject, text, html }) => {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: `ventas314.com <${from}>`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } } } },
      }),
    );
  }, mailGuard(env));
}
