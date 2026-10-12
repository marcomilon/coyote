/**
 * SES bounces and complaints, and the guard in front of every send. SES publishes the events of our configuration
 * set to SNS; the `mail-events` Lambda suppresses the addresses (a hard bounce or a complaint: we never send to it
 * again). The SES account-level suppression list stays on as a backstop. CloudWatch alarms on the account's bounce
 * and complaint rates call the same Lambda, which turns the `email` switch off (`./coyote.sh email on` resumes).
 */
import type { Email, SendEmail } from './mail';
import { emailId } from './token';

export type SuppressReason = 'bounce' | 'complaint';

export interface MailGuard {
  /** False while the `email` switch is off. */
  sendingOn(): Promise<boolean>;
  isSuppressed(emailId: string): Promise<boolean>;
}

/** Sends unless sending is paused or the address is suppressed; a skipped email is logged, never an error. */
export function guardedSend(send: SendEmail, guard: MailGuard): SendEmail {
  return async (email: Email) => {
    if (!(await guard.sendingOn())) {
      console.warn('email paused: not sent', { subject: email.subject });
      return;
    }
    if (await guard.isSuppressed(emailId(email.to))) {
      console.warn('suppressed address: not sent', { subject: email.subject });
      return;
    }
    await send(email);
  };
}

/**
 * The addresses to suppress in one SES event (an SNS message body). Event publishing names the type
 * `eventType`, feedback notifications `notificationType`; both are read. Only permanent bounces count:
 * a full mailbox or a timeout is SES's to retry.
 */
export function suppressionsOf(message: string): { reason: SuppressReason; emails: string[] } | undefined {
  let event: {
    eventType?: string;
    notificationType?: string;
    bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
    complaint?: { complainedRecipients?: { emailAddress?: string }[] };
  };
  try {
    event = JSON.parse(message);
  } catch {
    return undefined;
  }
  const type = event.eventType ?? event.notificationType;
  const addresses = (list: { emailAddress?: string }[] | undefined) => (list ?? []).map((r) => r.emailAddress ?? '').filter(Boolean);
  if (type === 'Bounce' && event.bounce?.bounceType === 'Permanent') return { reason: 'bounce', emails: addresses(event.bounce.bouncedRecipients) };
  if (type === 'Complaint') return { reason: 'complaint', emails: addresses(event.complaint?.complainedRecipients) };
  return undefined;
}
