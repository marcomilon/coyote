import { describe, expect, it } from 'vitest';
import { linkSite, requestLogin } from '../src/core/account';
import type { HumanCheck, VerifyHuman } from '../src/core/captcha';
import { reportSite } from '../src/core/report';
import { submit } from '../src/core/submit';
import { body, harness, NOW } from './harness';

/** A verifier that answers `result` and records the tokens it saw. */
function verifier(result: HumanCheck) {
  const seen: (string | undefined)[] = [];
  const verify: VerifyHuman = async (token) => {
    seen.push(token);
    return result;
  };
  return { verify, seen };
}

describe('CAPTCHA', () => {
  it('a refused token stops a new site before the rate limit and any model call', async () => {
    const t = harness();
    const v = verifier('bad');
    expect(await submit({ ...body, turnstileToken: 'tok' }, '1.2.3.4', { ...t.submitDeps, verifyHuman: v.verify })).toEqual({ status: 403 });
    expect(v.seen).toEqual(['tok']);
    expect(t.calls).toHaveLength(0);
    expect(t.started).toEqual([]);
    expect(t.jobs.size).toBe(0);
    // No daily quota used: the same IP still gets its 3 sites.
    for (let i = 0; i < 3; i++) expect((await submit({ ...body, businessName: `Panadería ${i}` }, '1.2.3.4', t.submitDeps)).status).toBe(202);
  });

  it('a person, Cloudflare down, or no verifier: the site goes ahead', async () => {
    for (const deps of [verifier('ok').verify, verifier('unreachable').verify, undefined]) {
      const t = harness();
      expect(await submit({ ...body, turnstileToken: 'tok' }, '1.2.3.4', { ...t.submitDeps, verifyHuman: deps })).toEqual({ status: 202, jobId: 'job-1' });
    }
  });

  it('a missing token reaches the verifier as undefined; an invalid body is 400 before it', async () => {
    const t = harness();
    const v = verifier('bad');
    expect(await submit({ ...body }, '1.2.3.4', { ...t.submitDeps, verifyHuman: v.verify })).toEqual({ status: 403 });
    expect(await submit({ ...body, turnstileToken: 'x'.repeat(3000) }, '1.2.3.4', { ...t.submitDeps, verifyHuman: v.verify })).toMatchObject({ status: 400 });
    expect(v.seen).toEqual([undefined]);
  });

  it('a sign-in link needs a person: no email and no count on a refused token', async () => {
    const t = harness();
    await linkSite(t.stores, 'luna@example.com', 'es', { slug: 'panaderia-luna', businessName: 'Panadería Luna', createdAt: NOW });
    const bad = verifier('bad');
    for (let i = 0; i < 5; i++) expect(await requestLogin({ email: 'luna@example.com', turnstileToken: 'tok' }, '1.2.3.4', { ...t.accountDeps, verifyHuman: bad.verify })).toEqual({ status: 403 });
    expect(t.emails).toHaveLength(0);
    expect(await requestLogin({ email: 'luna@example.com', turnstileToken: 'tok' }, '1.2.3.4', { ...t.accountDeps, verifyHuman: verifier('ok').verify })).toEqual({ status: 202 });
    expect(t.emails).toHaveLength(1);
  });

  it('a report needs a person: the admin hears nothing on a refused token', async () => {
    const t = harness();
    t.sites.set('sitio-malo', { slug: 'sitio-malo', status: 'published', jobId: 'j1', createdAt: 1 });
    const sent: string[] = [];
    const deps = { stores: t.stores, ipSalt: 's', notify: async (subject: string) => void sent.push(subject), now: () => NOW };
    expect(await reportSite('sitio-malo', 'spam', '1.1.1.1', { ...deps, verifyHuman: verifier('bad').verify }, 'tok')).toEqual({ status: 403 });
    expect(sent).toHaveLength(0);
    expect(await reportSite('sitio-malo', 'spam', '1.1.1.1', { ...deps, verifyHuman: verifier('ok').verify }, 'tok')).toMatchObject({ status: 202, counted: true });
    expect(sent).toHaveLength(1);
  });
});
