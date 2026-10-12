import { describe, expect, it } from 'vitest';
import { GuardrailBlocked, type CallTool } from '../src/core/bedrock';
import { submitAnswers } from '../src/core/clarify';
import { recordGenerateCrash, runGenerateJob } from '../src/core/generate-job';
import { publicJob, PENDING_TIMEOUT_MS } from '../src/core/jobs';
import { editSite } from '../src/core/owner';
import { submit } from '../src/core/submit';
import { QUESTIONS } from './fixtures';
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

  it('asks for a new description when it names no business: no notice, no slug, and the try is given back', async () => {
    const t = harness({ clarity: 'unusable' });
    const notices: string[] = [];
    t.submitDeps.announce = async (_: string, message: string) => void notices.push(message);
    for (let i = 0; i < 5; i++) expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 422, unclear: true });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'unclear' });
    expect(notices).toEqual([]);
    expect(t.sites.size).toBe(0);
    expect(t.started).toEqual([]);
    t.options.clarity = 'clear';
    expect((await submit(body, '1.2.3.4', t.submitDeps)).status).toBe(202); // the day's limit is untouched
  });

  it('asks for a new description when it does not say what the business sells', async () => {
    const t = harness({ offers: false });
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 422, unclear: true });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'unclear' });
    expect(t.calls).toEqual(['classify']); // no plan_site, no page writer
  });

  it('sends our own example, copied back, to the form again without a model call or a count', async () => {
    const t = harness();
    expect(await submit({ ...body, about: '«Panadería en Rosario: pan de masa madre y tortas por encargo».' }, '1.2.3.4', t.submitDeps)).toEqual({ status: 422, unclear: true });
    expect(t.calls).toEqual([]);
    expect(t.counters.size).toBe(0);
  });

  it('a policy rejection wins over an unclear description', async () => {
    const t = harness({ classify: 'reject', clarity: 'unusable' });
    expect(await submit(body, '1.2.3.4', t.submitDeps)).toEqual({ status: 422 });
    expect(t.jobs.get('job-1')).toMatchObject({ rejectedBy: 'prescreen' });
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
  it('writes the page with the page writer, keeps its record, issues the magic link, and marks the job DONE', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });

    expect(t.calls).toEqual(['classify', 'plan_site']);
    expect(t.writer.requests).toHaveLength(1);
    const job = t.jobs.get('job-1')!;
    expect(job).toMatchObject({ status: 'DONE', draftUrl: 'https://sites.test/_draft/draft1/' });
    expect(job.ownerToken).toMatch(/^panaderia-luna\./);
    expect(job.usage.map((u) => u.step)).toEqual(['classify', 'plan_site', 'write_page']);

    const page = t.objects.get('_draft/draft1/index.html')!;
    expect(page).toContain('href="https://wa.me/573001234567"');
    expect(page).toContain('Página web creada con ventas314.com');
    const doc = JSON.parse(t.objects.get('_src/panaderia-luna/draft1.json')!);
    expect(doc).toMatchObject({ answers: { contact: { whatsapp: '573001234567' } }, media: { photos: [] } });
    expect(doc.page).toContain('<h1>Panadería Luna</h1>');
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
    expect(t.calls).toEqual(['classify', 'plan_site', 'classify']); // answers are screened; only one round of questions
    const write = t.writer.requests.at(-1)!;
    expect(write.notes.map((n) => n.answer).join(' ')).toContain('Hogazas de masa madre a $18.000');
    expect(write.notes.map((n) => n.answer)).toContain('Clásico');
    expect(JSON.stringify(write)).toContain('5551234'); // the page writer gets the owner's real number
    expect(write.answers.contact.phone).toMatch(/^57/);
    // The real number is in the site's contact details.
    expect(JSON.parse(t.objects.get('_src/panaderia-luna/draft1.json')!).answers.contact.phone).toBe('576015551234');
  });

  it('"Saltar preguntas y continuar" skips the questions with no extra model call', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual({ status: 202 });
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.calls).toEqual(['classify', 'plan_site']);
    expect(t.writer.requests).toHaveLength(1);
    expect(t.jobs.get('job-1')!.status).toBe('DONE');
  });

  it('when the description does not say what the business sells, that question is required: no skip, and the answer must say it', async () => {
    const t = harness({ questions: QUESTIONS, enough: false, offersQuestion: 'servicios' });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    const waiting = t.jobs.get('job-1')!;
    expect(publicJob(waiting, waiting.createdAt)).toMatchObject({ status: 'NEEDS_INPUT', requiredQuestion: 'servicios' });
    const required = { status: 400, fields: ['servicios'], required: true };

    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual(required);
    expect(await submitAnswers('job-1', { answers: { estilo: 'Moderno', telefono: '+57 601 555 1234' } }, t.answersDeps)).toEqual(required);
    expect(await submitAnswers('job-1', { answers: { servicios: 'Panadería en Cusco: pan de masa madre y tortas por encargo' } }, t.answersDeps)).toEqual(required);
    t.options.offers = false;
    expect(await submitAnswers('job-1', { answers: { servicios: 'Lo mejor, con calidad y compromiso.' } }, t.answersDeps)).toEqual(required);
    t.options.clarity = 'unusable';
    t.options.offers = true;
    expect(await submitAnswers('job-1', { answers: { servicios: 'asdf asdf' } }, t.answersDeps)).toEqual(required);
    expect(t.jobs.get('job-1')!.status).toBe('NEEDS_INPUT');

    t.options.clarity = 'thin';
    expect(await submitAnswers('job-1', { answers: { servicios: 'Hogazas de masa madre y croissants.' } }, t.answersDeps)).toEqual({ status: 202 });
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')!.status).toBe('DONE');
  });

  it('questions stay optional when the description says what the business offers', async () => {
    const t = harness({ questions: QUESTIONS, enough: true });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(publicJob(t.jobs.get('job-1')!, 0).requiredQuestion).toBeUndefined();
    expect(await submitAnswers('job-1', { skip: true }, t.answersDeps)).toEqual({ status: 202 });
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

describe('one free draft per email', () => {
  it('a second site for the same email is refused at submit, before any model call, even after the first is deleted', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'DONE' });
    expect(t.jobs.get('job-1')).toMatchObject({ freeDraft: true });

    const calls = t.calls.length;
    expect(await submit({ ...body, businessName: 'Florería Sol' }, '5.6.7.8', t.submitDeps)).toEqual({ status: 409 });
    expect(await submit({ ...body, ownerEmail: body.ownerEmail.toUpperCase() }, '5.6.7.8', t.submitDeps)).toEqual({ status: 409 });
    expect(t.calls.length).toBe(calls);

    await t.stores.deleteSite('panaderia-luna');
    expect(await submit(body, '5.6.7.8', t.submitDeps)).toEqual({ status: 409 }); // deleting does not give it back
    expect((await submit({ ...body, ownerEmail: 'otra@correo.com' }, '5.6.7.8', t.submitDeps)).status).toBe(202);
  });

  it('two sites sent at once: only the first to reach the page writer gets it', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    await submit({ ...body, businessName: 'Florería Sol' }, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(await runGenerateJob('job-2', t.generateDeps)).toMatchObject({ outcome: 'REJECTED' });
    const job = t.jobs.get('job-2')!;
    expect(job).toMatchObject({ status: 'REJECTED', rejectedBy: 'limit' });
    expect(publicJob(job, job.createdAt)).toMatchObject({ status: 'REJECTED', hasDraft: true });
    expect(t.writer.requests).toHaveLength(1);
    expect(t.sites.has('floreria-sol')).toBe(false);
  });

  it('waiting on questions uses nothing; a failed page gives the draft back', async () => {
    const t = harness({ questions: QUESTIONS });
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps); // NEEDS_INPUT
    expect((await submit({ ...body, businessName: 'Florería Sol' }, '1.2.3.4', t.submitDeps)).status).toBe(202);

    t.writer.options.fail = new Error('Opus down');
    await submitAnswers('job-1', { skip: true }, t.answersDeps);
    expect(await runGenerateJob('job-1', t.generateDeps)).toMatchObject({ outcome: 'FAILED' });
    expect((await submit({ ...body, businessName: 'Panadería Sol' }, '1.2.3.4', t.submitDeps)).status).toBe(202);
  });
});

describe('runGenerateJob: failures', () => {
  it('rejects a page that breaks the content policy, and frees the slug', async () => {
    const t = harness();
    t.writer.options.page = (r) => `<!doctype html><html><head><title>x</title></head><body><h1>${r.answers.businessName}</h1><p>Verifica tu cuenta bancaria ingresando tu clave para seguir comprando.</p><p>${'x '.repeat(300)}</p></body></html>`;
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'REJECTED', rejectedBy: 'policy' });
    expect(t.sites.size).toBe(0);
    expect([...t.objects.keys()].filter((k) => k.startsWith('_draft/'))).toEqual([]);
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
    expect(publicJob(job, job.createdAt + 1000)).toEqual({ jobId: 'job-1', status: 'PENDING', kind: 'create', slug: 'panaderia-luna', lang: 'es', stage: 'clarify', questions: undefined, draftUrl: undefined });
    expect(JSON.stringify(publicJob(job, job.createdAt))).not.toContain('example.com'); // never the owner's email
    expect(publicJob(job, job.createdAt + PENDING_TIMEOUT_MS + 1).status).toBe('FAILED');
    // The clock restarts when the owner answers.
    expect(publicJob({ ...job, startedAt: job.createdAt + PENDING_TIMEOUT_MS }, job.createdAt + PENDING_TIMEOUT_MS + 1).status).toBe('PENDING');
  });
});


describe('the admin notice for new sites', () => {
  it('goes out once per new site, with the owner, the draft link, and the description; an edit gets its own', async () => {
    const t = harness();
    const notices: { subject: string; message: string }[] = [];
    const deps = { ...t.generateDeps, announce: async (subject: string, message: string) => void notices.push({ subject, message }) };
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', deps)).toMatchObject({ outcome: 'DONE' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('Nuevo sitio: Panadería Luna');
    expect(notices[0]!.message).toContain('panaderia-luna');
    expect(notices[0]!.message).toContain(t.generateDeps.urls.draftUrl('draft1'));
    expect(notices[0]!.message).toContain(body.about);
    // A second run of the same job (a retry) is skipped, and an owner's edit is not a new site.
    await runGenerateJob('job-1', deps);
    expect(notices).toHaveLength(1);
    expect(await editSite(t.sites.get('panaderia-luna')!, { instruction: 'agrega que abrimos los domingos' }, t.ownerDeps)).toMatchObject({ status: 202 });
    expect(await runGenerateJob('job-2', deps)).toMatchObject({ outcome: 'DONE' });
    expect(notices).toHaveLength(2);
    expect(notices[1]!.subject).toBe('Rediseño: Panadería Luna');
    expect(notices[1]!.message).toContain('Pedido: agrega que abrimos los domingos');
    expect(notices[1]!.message).toContain(t.generateDeps.urls.draftUrl('draft2'));
    expect(notices[1]!.message).toMatch(/^Costo: \$/m);
    expect(notices[1]!.message).toMatch(/^Redactor: /m);
  });

  it('a redesign says what it cost, step by step', async () => {
    const t = harness();
    const notices: { subject: string; message: string }[] = [];
    const opus = async (...args: Parameters<typeof t.writer.writePage>) => ({ ...(await t.writer.writePage(...args)), usage: { step: 'edit_page', modelId: 'claude-opus-5-5', inputTokens: 20_000, outputTokens: 20_000 } });
    const deps = { ...t.generateDeps, writePage: opus, announce: async (subject: string, message: string) => void notices.push({ subject, message }) };
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', deps);
    await editSite(t.sites.get('panaderia-luna')!, { instruction: 'todo en verde' }, t.ownerDeps);
    await runGenerateJob('job-2', deps);
    expect(notices[1]!.message).toContain('  página (claude-opus-5-5): $0.48'); // 20k × $4 + 20k × $20 per million
  });

  it('says what the site cost, step by step, and how the page writer was set', async () => {
    const t = harness();
    const notices: string[] = [];
    Object.assign(t.writer.options, { images: ['Bread'] });
    const deps = {
      ...t.generateDeps,
      pageModel: 'claude-opus-5-5',
      pageSkill: null,
      pageLook: false,
      generateImage: async () => new Uint8Array([1]),
      imageModelId: 'stability.stable-image-core-v1:1',
      writePage: async (...args: Parameters<typeof t.writer.writePage>) => ({ ...(await t.writer.writePage(...args)), usage: { step: 'write_page', modelId: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 30_000 } }),
      announce: async (_: string, message: string) => void notices.push(message),
    };
    await submit({ ...body, aiImages: true }, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', deps)).toMatchObject({ outcome: 'DONE' });
    const message = notices[0]!;
    expect(message).toContain('  página (claude-opus-5-5): $0.64'); // 10k × $4 + 30k × $20 per million
    expect(message).toContain('  fotos (1 × stability.stable-image-core-v1:1): $0.04');
    expect(message).toMatch(/^Costo: \$0\.68 \+ desconocido$/m); // the fake models of the other steps have no price
    expect(message).toContain('Redactor: claude-opus-5-5, esfuerzo high · skill none · look off · fotos IA on (dueño: on)');
  });

  it('a failed notice never fails the job', async () => {
    const t = harness();
    await submit(body, '1.2.3.4', t.submitDeps);
    const deps = { ...t.generateDeps, announce: async () => { throw new Error('SNS down'); } };
    expect(await runGenerateJob('job-1', deps)).toMatchObject({ outcome: 'DONE' });
    expect(t.sites.get('panaderia-luna')).toMatchObject({ currentDraftId: 'draft1' });
  });
});

describe('the admin notice for failures', () => {
  const collect = () => {
    const notices: { subject: string; message: string }[] = [];
    return { notices, announce: async (subject: string, message: string) => void notices.push({ subject, message }) };
  };

  it('a page writer that errs: the error and what the job spent before it', async () => {
    const t = harness();
    const { notices, announce } = collect();
    t.writer.options.fail = new Error('overloaded_error');
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', { ...t.generateDeps, announce })).toMatchObject({ outcome: 'FAILED' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('Sitio falló: Panadería Luna');
    expect(notices[0]!.message).toContain('Error: Error: page writer failed: Error: overloaded_error');
    expect(notices[0]!.message).toMatch(/^Costo: /m);
    expect(notices[0]!.message).toMatch(/^  preguntas \(/m); // the questions step ran before the writer
    expect(notices[0]!.message).toContain('el costo real puede ser algo mayor');
  });

  it('a timeout the Lambda could not record: the job fails, its slug is free, and the notice says the run is not counted', async () => {
    const t = harness();
    const { notices, announce } = collect();
    await submit(body, '1.2.3.4', t.submitDeps);
    await recordGenerateCrash('job-1', 'Task timed out after 600.00 seconds', { stores: t.stores, announce });
    expect(t.jobs.get('job-1')).toMatchObject({ status: 'FAILED', error: 'Task timed out after 600.00 seconds' });
    expect(t.sites.size).toBe(0);
    expect(notices[0]!.subject).toBe('Sitio falló: Panadería Luna');
    expect(notices[0]!.message).toContain('No incluye lo que gastó la ejecución que se cortó');
    // A job that already ended is left alone.
    await recordGenerateCrash('job-1', 'again', { stores: t.stores, announce });
    expect(notices).toHaveLength(1);
  });

  it('a failed redesign says so, with the request', async () => {
    const t = harness();
    const { notices, announce } = collect();
    await submit(body, '1.2.3.4', t.submitDeps);
    await runGenerateJob('job-1', t.generateDeps);
    await editSite(t.sites.get('panaderia-luna')!, { instruction: 'todo en verde' }, t.ownerDeps);
    t.writer.options.fail = new Error('boom');
    await runGenerateJob('job-2', { ...t.generateDeps, announce });
    expect(notices[0]!.subject).toBe('Cambio falló: Panadería Luna');
    expect(notices[0]!.message).toContain('Pedido: todo en verde');
  });
});

describe('the admin notice for rejections', () => {
  const collect = () => {
    const notices: { subject: string; message: string }[] = [];
    return { notices, announce: async (subject: string, message: string) => void notices.push({ subject, message }) };
  };

  it('at submit: a brand name and a rejection by the pre-screen, with the reason', async () => {
    const t = harness();
    const { notices, announce } = collect();
    await submit({ ...body, businessName: 'Bancolombia Soporte' }, '1.2.3.4', { ...t.submitDeps, announce });
    expect(notices[0]).toMatchObject({ subject: 'Sitio rechazado: Bancolombia Soporte' });
    expect(notices[0]!.message).toContain('Motivo: brand — bancolombia');
    const u = harness({ classify: 'reject' });
    const second = collect();
    await submit(body, '1.2.3.4', { ...u.submitDeps, announce: second.announce });
    expect(second.notices[0]!.message).toContain('Motivo: prescreen — adult');
  });

  it('after generation: a page the checks reject', async () => {
    const t = harness();
    t.writer.options.page = () => `<!doctype html><html><head><title>Luna</title></head><body><h1>Panadería Luna</h1><p>Llama al +57 311 999 0000</p><p>${'x '.repeat(300)}</p></body></html>`;
    const { notices, announce } = collect();
    await submit(body, '1.2.3.4', t.submitDeps);
    expect(await runGenerateJob('job-1', { ...t.generateDeps, announce })).toMatchObject({ outcome: 'REJECTED' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('Sitio rechazado: Panadería Luna');
    expect(notices[0]!.message).toContain('Motivo: policy');
    // The page was written before the checks refused it: the notice says what it cost.
    expect(notices[0]!.message).toMatch(/^Costo: /m);
    expect(notices[0]!.message).toMatch(/^  página \(/m);
  });
});
