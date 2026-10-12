import { describe, expect, it, vi } from 'vitest';
import type { Email } from '../src/core/mail';
import { guardedSend, suppressionsOf } from '../src/core/mail-events';
import { emailId } from '../src/core/token';

const email: Email = { to: 'Dueña@Example.com', subject: 's', text: 't', html: 'h' };

describe('guardedSend', () => {
  it('sends to an address that is not suppressed', async () => {
    const send = vi.fn(async () => {});
    await guardedSend(send, { sendingOn: async () => true, isSuppressed: async () => false })(email);
    expect(send).toHaveBeenCalledWith(email);
  });

  it('skips a suppressed address, looked up by its emailId', async () => {
    const send = vi.fn(async () => {});
    const isSuppressed = vi.fn(async (id: string) => id === emailId('dueña@example.com'));
    await guardedSend(send, { sendingOn: async () => true, isSuppressed })(email);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing while email is off', async () => {
    const send = vi.fn(async () => {});
    await guardedSend(send, { sendingOn: async () => false, isSuppressed: async () => false })(email);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('suppressionsOf', () => {
  const recipients = [{ emailAddress: 'a@example.com' }];
  it('suppresses permanent bounces and complaints', () => {
    expect(suppressionsOf(JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: recipients } }))).toEqual({ reason: 'bounce', emails: ['a@example.com'] });
    expect(suppressionsOf(JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: recipients } }))).toEqual({ reason: 'complaint', emails: ['a@example.com'] });
  });

  it('leaves transient bounces, other events, and junk alone', () => {
    expect(suppressionsOf(JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: recipients } }))).toBeUndefined();
    expect(suppressionsOf(JSON.stringify({ eventType: 'Delivery' }))).toBeUndefined();
    expect(suppressionsOf('not json')).toBeUndefined();
  });
});
