import { describe, expect, it } from 'vitest';
import { GuardrailBlocked, type CallTool } from '../src/core/bedrock';
import { submitAnswers } from '../src/core/clarify';
import { runGenerateJob } from '../src/core/generate-job';
import { publicJob, PENDING_TIMEOUT_MS } from '../src/core/jobs';
import { submit } from '../src/core/submit';
import { MODEL_PAGE, QUESTIONS } from './fixtures';
import { body, harness } from './harness';

describe('submit', () => {
  it('accepts a normal request: claims the clean slug, stores the job, starts generation', async () => {
    const t = harness();
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 202, jobId: 'job-1' });
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'claimed', jobId: 'job-1' });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'PENDING', slug: 'panaderia-luna' });
    expect(t.jobs.get('job-1')!.ipHash).not.toContain('1.2.3.4');
    expect(t.started).toEqual(['job-1']);
  });

  it('rejects invalid input without touching the quota or the model', async () => {
    const t = harness();
    expect(await submit({ ...body, whatsapp: '123' }, '1.2.3.4', t.submitDeps)).toEqual({ status: 400, fields: ['contact.whatsapp'] });
    expect(await submit('not json', '1.2.3.4', t.submitDeps)).toMatchObject({ status: 400 });
    expect(t.calls).toEqual([]);
    expect(t.counters.size).toBe(0);
  });

  it('rate limits per IP before any model call', async () => {
    const t = harness();
    for (let i = 0; i < 3; i++) expect((await submit(body, '1.2.3.4', t.submitDeps)).status).toBe(202);
    const callsBefore = t.calls.length;
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 429 });
    expect(t.calls.length).toBe(callsBefore);
    expect((await submit(body, '5.6.7.8', t.submitDeps)).status).toBe(202); // another visitor is unaffected
  });

  it('rejects a brand name without a model call, and records why', async () => {
    const t = harness();
    expect(await submit({ ...body, businessName: 'Bancolombia Soporte' }, '1.2.3.4', t.submitDeps)).toEqual({ status: 422 });
    expect(t.calls).toEqual([]);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'brand' });
    expect(t.sites.size).toBe(0);
  });

  it('rejects what the classifier rejects, claiming no slug and starting nothing', async () => {
    const t = harness({ classify: 'reject' });
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'prescreen', rejectDetail: 'adult' });
    expect(t.sites.size).toBe(0);
    expect(t.started).toEqual([]);
  });

  it('treats a guardrail block on the input as a rejection', async () => {
    const t = harness();
    t.submitDeps.callTool = (async () => {
      throw new GuardrailBlocked();
    }) as CallTool;
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ rejectedBy: 'guardrail' });
  });

  it('adds a suffix when the slug is taken, reserved, or blocklisted', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await submit(body, '5.6.7.8', t.submitDeps);
    expect(t.jobs.get('job-2')!.slug).toMatch(/^panaderia-luna-[a-z0-9]{4}$/);

    await submit({ ...body, businessName: 'Admin' }, '9.9.9.9', t.submitDeps);
    expect(t.jobs.get('job-3')!.slug).toMatch(/^admin-[a-z0-9]{4}$/);

    t.blocked.add('floreria-sol');
    await submit({ ...body, businessName: 'Florería Sol' }, '8.8.8.8', t.submitDeps);
    expect(t.jobs.get('job-4')!.slug).toMatch(/^floreria-sol-[a-z0-9]{4}$/);
  });
});

describe('runGenerateJob: a detailed request goes straight to the draft', () => {
  it('writes the filled draft, keeps the source, issues the magic link, and marks the job DONE', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });

    expect(t.calls).toEqual(['classify', 'plan_site', 'write_site']);
    const job = t.jobs.get('job-1')!;
    expect(job).toMatchObject({ status: 'DONE', draftUrl: 'https://sites.test/_draft/draft1/' });
    expect(job.ownerToken).toMatch(/^panaderia-luna\./);
    expect(job.usage.map((u) => u.step)).toEqual(['classify', 'plan_site', 'write_site']);

    const page = t.objects.get('_draft/draft1/index.html')!;
    expect(page).toContain('href="https://wa.me/573001234567?text=');
    expect(page).toContain('https://maps.google.com/maps?q=Calle%2060%20%23%209-12&amp;z=16&amp;output=embed');
    expect(page).not.toContain('{{');
    expect(t.objects.get('_src/panaderia-luna/draft1.html')).toContain('{{whatsapp_url}}');
    expect(t.sites.get('panaderia-luna')).toMatchObject({ status: 'draft', currentDraftId: 'draft1', drafts: ['draft1'], ownerWhatsApp: '573001234567' });
    expect(t.sites.get('panaderia-luna')!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing is published: no {slug}/ page.
    expect([...t.objects.keys()].some((key) => key.startsWith('panaderia-luna/'))).toBe(false);
  });

  it('hands the magic link out once: the first status read takes it off the job', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const token = await t.stores.takeOwnerToken('job-1');
    expect(token).toMatch(/^panaderia-luna\./);
    expect(await t.stores.takeOwnerToken('job-1')).toBeUndefined();
    expect(JSON.stringify(t.jobs.get('job-1'))).not.toContain(token!.split('.')[1]);
  });

  it('ignores jobs that are not PENDING', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const calls = t.calls.length;
    expect(await runGenerateJob('job-1', t.generateDeps)).toEqual({ outcome: 'SKIPPED' });
    expect(t.calls.length).toBe(calls);
  });
});

describe('questions', () => {
  it('a vague request stops at NEEDS_INPUT with the questions; the answers resume it at the write stage', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'NEEDS_INPUT' });
    const waiting = t.jobs.get('job-1')!;
    expect(publicJob(waiting, waiting.createdAt)).toMatchObject({ status: 'NEEDS_INPUT', questions: QUESTIONS });
    expect(t.objects.size).toBe(0);

    const answers = { servicios: 'Hogazas de masa madre a $18.000 y croissants.', estilo: 'Clásico', telefono: '+57 601 555 1234' };
    expect(await submitAnswers('job-1', { answers }, t.answersDeps)).toEqual({ status: 202 });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'PENDING', stage: 'write' });
    expect(t.started).toEqual(['job-1', 'job-1']);

    await runGenerateJob('job-1', t.generateDeps);
    expect(t.calls).toEqual(['classify', 'plan_site', 'classify', 'write_site']); // answers are screened; only one round of questions
    const write = t.requests.at(-1)!;
    expect(write.guarded).toContain('Hogazas de masa madre a $18.000');
    expect(write.guarded).toContain('→ Clásico');
    expect(write.guarded).not.toContain('555'); // the contact answer never reaches the model
    const page = t.objects.get('_draft/draft1/index.html')!;
    expect(page).toContain('href="tel:+576015551234"'); // it reaches the page through the placeholder
    expect(page).toContain('Teléfono:');
  });

  it('"Generar así" skips the questions with no extra model call', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual({ status: 202 });
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.calls).toEqual(['classify', 'plan_site', 'write_site']);
    expect(t.jobs.get('job-1')!.status).toBe('DONE');
    expect(t.objects.get('_draft/draft1/index.html')).not.toContain('Teléfono:'); // data-needs removed the group
  });

  it('validates answers like the form, and accepts them only once', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(await submitAnswers('job-1', { answers: { telefono: '12' } }, t.answersDeps)).toEqual({ status: 400, fields: ['telefono'] });
    expect(await submitAnswers('job-1', { answers: { estilo: 'Neón' } }, t.answersDeps)).toEqual({ status: 400, fields: ['estilo'] });
    expect(await submitAnswers('job-1', { answers: { otra: 'x' } }, t.answersDeps)).toEqual({ status: 400, fields: ['otra'] });
    expect(await submitAnswers('job-1', { answers: { servicios: 'x'.repeat(501) } }, t.answersDeps)).toMatchObject({ status: 400 });
    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual({ status: 202 });
    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual({ status: 409 });
    expect(await submitAnswers('nope', { skip: true }, t.answersDeps)).toEqual({ status: 404 });
  });

  it('rejects answers the pre-screen rejects, and frees the slug', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    t.options.classify = 'reject';
    expect(await submitAnswers('job-1', { answers: { servicios: 'Otra cosa' } }, t.answersDeps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'prescreen' });
    expect(t.sites.size).toBe(0);
  });

  it('drops questions about contact details the owner already gave', async () => {
    const t = harness({ questions: [{ id: 'wa', label: '¿Tu WhatsApp?', type: 'whatsapp' }, { id: 'dir', label: '¿Tu dirección?', type: 'address' }] });
    await submit(body, '1.2.3.4', t.submitDeps); // the form gave both
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });
  });

  it('drops questions that carry a URL or a phone number', async () => {
    const t = harness({ questions: [{ id: 'web', label: 'Visita https://evil.test y dinos', type: 'text' }] });
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });
  });
});

describe('runGenerateJob: failures', () => {
  it('rejects a page that breaks the content policy, and frees the slug', async () => {
    const t = harness();
    t.options.page = withMarkup('<p>Verifica tu cuenta para seguir comprando.</p>');
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    expect(t.sites.size).toBe(0);
    expect([...t.objects.keys()].filter((k) => k.startsWith('_draft/'))).toEqual([]);
  });

  it('retries a page the sanitizer refuses once, with the problems as feedback, then rejects it', async () => {
    const t = harness();
    t.options.page = withMarkup('<form action="https://evil.test"><input name="clave"></form>');
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.calls.filter((c) => c === 'write_site')).toHaveLength(2);
    expect(t.requests.at(-1)!.user).toContain('<form> is not allowed');
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    expect(t.jobs.get('job-1')!.usage.filter((u) => u.step === 'write_site')).toHaveLength(2); // both attempts are paid for
  });

  it('rejects when the output guardrail blocks the text', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', { ...t.generateDeps, outputAllowed: async () => false });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'guardrail' });
    expect(t.objects.size).toBe(0);
  });

  it('marks the job FAILED on an unexpected error and frees the slug', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    const failing = (async () => {
      throw new Error('bedrock is down');
    }) as CallTool;
    await runGenerateJob('job-1', { ...t.generateDeps, callTool: failing });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'FAILED' });
    expect(t.sites.size).toBe(0);
  });
});

describe('status', () => {
  it('shows the browser only public fields, and FAILED for a stuck job', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    const job = t.jobs.get('job-1')!;
    expect(publicJob(job, job.createdAt + 1000)).toEqual({ jobId: 'job-1', status: 'PENDING', kind: 'create', slug: 'panaderia-luna', lang: 'es', questions: undefined, draftUrl: undefined });
    expect(publicJob(job, job.createdAt + PENDING_TIMEOUT_MS + 1).status).toBe('FAILED');
    // The clock restarts when the owner answers.
    expect(publicJob({ ...job, startedAt: job.createdAt + PENDING_TIMEOUT_MS }, job.createdAt + PENDING_TIMEOUT_MS + 1).status).toBe('PENDING');
  });
});

function withMarkup(markup: string): string {
  return MODEL_PAGE.replace('</main>', `${markup}</main>`);
}
