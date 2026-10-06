import { describe, expect, it } from 'vitest';
import { accountView, checkSession, LOGIN_TTL_MS, requestLogin, SESSION_TTL_MS, startSession } from '../src/core/account';
import { runGenerateJob } from '../src/core/generate-job';
import { publicJob } from '../src/core/jobs';
import { authenticate, deleteSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { emailId } from '../src/core/token';
import { body, harness, NOW, urls } from './harness';

const ID = emailId('luna@example.com');

/** A site made with the harness's email, and the sign-in link of its ready email. */
async function withSite(t = harness(), extra: Partial<typeof body> = {}) {
  await submit({ ...body, ...extra }, '1.2.3.4', t.submitDeps);
  const jobId = `job-${t.jobs.size}`;
  await runGenerateJob(jobId, t.generateDeps);
  return t;
}

const loginFrom = (text: string) => decodeURIComponent(/#login=([^&\s]+)/.exec(text)![1]!);

describe('Mis sitios', () => {
  it('a new site is linked to the email of the form, which never reaches a model', async () => {
    const t = await withSite();
    expect(t.sites.get('panaderia-luna')!.ownerEmailId).toBe(ID);
    expect(t.accounts.get(ID)).toMatchObject({ email: 'luna@example.com', lang: 'es', sites: [{ slug: 'panaderia-luna', businessName: 'Panadería Luna' }] });
    expect(JSON.stringify(t.requests)).not.toContain('example.com');
    expect(JSON.stringify(t.writer.requests)).not.toContain('example.com');
  });

  it('the form requires a valid email', async () => {
    const t = harness();
    const { ownerEmail: _, ...noEmail } = body;
    expect(await submit(noEmail, '1.2.3.4', t.submitDeps)).toEqual({ status: 400, fields: ['ownerEmail'] });
    expect(await submit({ ...body, ownerEmail: 'no' }, '1.2.3.4', t.submitDeps)).toEqual({ status: 400, fields: ['ownerEmail'] });
  });

  it('once there are no questions the job says so, and the ready email signs the owner in with the site selected', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'DONE', stage: 'write' });
    expect(t.emails).toHaveLength(1);
    const [email] = t.emails;
    expect(email).toMatchObject({ to: 'luna@example.com', subject: 'Tu sitio está listo: Panadería Luna' });
    expect(email!.text).toContain(`${urls.appUrl}/mis-sitios#login=`);
    expect(email!.text).toContain('&site=panaderia-luna');
    expect(await startSession({ login: loginFrom(email!.text) }, t.accountDeps)).toMatchObject({ status: 200 });
  });

  it('questions, rejections, failures, and edits send no email', async () => {
    const t = harness({ questions: [{ id: 'estilo', label: '¿Qué estilo?', type: 'text' }] });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(publicJob(t.jobs.get('job-1')!, NOW)).toMatchObject({ status: 'NEEDS_INPUT', stage: 'clarify' });
    expect(t.emails).toHaveLength(0);

    const u = harness();
    u.writer.options.fail = new Error('overloaded');
    await submit(body, '1.2.3.4', u.submitDeps);
    await runGenerateJob('job-1', u.generateDeps);
    expect(u.jobs.get('job-1')!.status).toBe('FAILED');
    expect(u.emails).toHaveLength(0);
  });

  it('a failing email never fails the site', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.generateDeps, sendEmail: async () => Promise.reject(new Error('SES down')) });
    expect(t.jobs.get('job-1')!.status).toBe('DONE');
  });

  it('a sign-in link goes only to an existing account, with the same answer either way, within the caps', async () => {
    const t = await withSite();
    t.emails.length = 0;
    expect(await requestLogin({ email: 'nadie@example.com' }, '1.2.3.4', t.accountDeps)).toEqual({ status: 202 });
    expect(t.emails).toHaveLength(0);
    expect(await requestLogin({ email: 'LUNA@example.com', lang: 'pt' }, '1.2.3.4', t.accountDeps)).toEqual({ status: 202 });
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]).toMatchObject({ to: 'luna@example.com', subject: 'Seus sites no Coyote' });
    expect(t.emails[0]!.text).toContain('- Panadería Luna');
    expect(t.emails[0]!.text).toContain(`${urls.appUrl}/pt/meus-sites#login=`);

    for (let i = 0; i < 5; i++) await requestLogin({ email: 'luna@example.com' }, '1.2.3.4', t.accountDeps);
    expect(t.emails).toHaveLength(3); // 3 per email per day
    expect(await requestLogin({ email: 'x' }, '1.2.3.4', t.accountDeps)).toEqual({ status: 400 });
    expect(await requestLogin({ email: 'luna@example.com' }, '1.2.3.4', { ...t.accountDeps, sendEmail: undefined })).toEqual({ status: 503 });
  });

  it('a link opens one session, once, within the hour', async () => {
    const t = await withSite();
    const login = loginFrom(t.emails[0]!.text);
    const later = { ...t.accountDeps, now: () => NOW + LOGIN_TTL_MS + 1 };
    expect(await startSession({ login }, later)).toEqual({ status: 401 });

    const u = await withSite();
    const again = loginFrom(u.emails[0]!.text);
    const session = await startSession({ login: again }, u.accountDeps);
    expect(session).toMatchObject({ status: 200, token: expect.stringMatching(/^@[\w-]+\.[\w-]{40,}$/), expiresAt: NOW + SESSION_TTL_MS });
    expect(await startSession({ login: again }, u.accountDeps)).toEqual({ status: 401 });
  });

  it('a session lists its sites and reaches each one like a magic link, but no other account’s', async () => {
    const t = await withSite();
    await withSite(t, { businessName: 'Taller Sol', ownerEmail: 'sol@example.com' });
    const { token } = (await startSession({ login: loginFrom(t.emails[0]!.text) }, t.accountDeps)) as { token: string };

    const id = (await checkSession(token, t.accountDeps))!;
    expect(id).toBe(ID);
    expect(await accountView(id, t.accountDeps)).toEqual({
      email: 'luna@example.com',
      sites: [{ slug: 'panaderia-luna', businessName: 'Panadería Luna', createdAt: NOW, draftUrl: urls.draftUrl('draft1'), previewUrl: urls.draftUrl(t.sites.get('panaderia-luna')!.previewId!) }],
    });

    expect(await authenticate(`Bearer panaderia-luna.${token}`, t.ownerDeps)).toMatchObject({ slug: 'panaderia-luna' });
    expect(await authenticate(`Bearer taller-sol.${token}`, t.ownerDeps)).toBeUndefined();
    expect(await authenticate(`Bearer panaderia-luna.${token}x`, t.ownerDeps)).toBeUndefined();
    expect(await authenticate(`Bearer panaderia-luna.${token}`, { ...t.ownerDeps, now: () => NOW + SESSION_TTL_MS + 1 })).toBeUndefined();
  });

  it('deleting a site takes it off the account, and the account goes with its last site', async () => {
    const t = await withSite();
    await deleteSite(t.sites.get('panaderia-luna')!, t.ownerDeps);
    expect(t.accounts.has(ID)).toBe(false);
    expect(t.jobs.get('job-1')!.ownerEmail).toBeUndefined();
  });
});
