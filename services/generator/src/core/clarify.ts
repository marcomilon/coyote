import { z } from 'zod';
import { GuardrailBlocked, type CallTool } from './bedrock';
import { releaseNewSite } from './generate-job';
import { announceRejection, type Announce } from './notices';
import type { Stores } from './jobs';
import { isRejected, isUnclear, prescreen } from './prescreen';
import { applyAnswers, type Note } from './questions';

export interface AnswersDeps {
  /** Notices for the admin (notices.ts). */
  announce?: Announce;
  stores: Stores;
  callTool: CallTool;
  prescreenModelId: string;
  startGenerate(jobId: string): Promise<void>;
  now(): number;
}

/** 400 with `required`: the question about what the business sells must be answered (no skip). */
export type AnswersResult = { status: 202 } | { status: 400; fields: string[]; required?: true } | { status: 404 } | { status: 409 } | { status: 422 };

const Body = z.object({ answers: z.unknown().optional(), skip: z.boolean().optional() });

/**
 * POST /jobs/{id}/answers: the owner's answers to the model's questions, or "Saltar preguntas y continuar" (skip). The job ID
 * is the credential, as for the status route. Only one round: the job goes back to PENDING at the write
 * stage, where the model has to build. Free-text answers pass the input guardrail and the pre-screen first.
 * When the description did not say what the business sells (`requiredQuestion`), skipping is refused, and an empty answer
 * to that question, or answers that still don't say what it sells, send the owner back to the questions.
 */
export async function submitAnswers(jobId: string, body: unknown, deps: AnswersDeps): Promise<AnswersResult> {
  const { stores } = deps;
  const job = await stores.getJob(jobId);
  if (!job) return { status: 404 };
  if (job.status !== 'NEEDS_INPUT' || !job.questions) return { status: 409 };

  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) return { status: 400, fields: ['answers'] };
  let notes: Note[] = [];
  let contact = {};
  if (!parsed.data.skip) {
    const applied = applyAnswers(job.questions, parsed.data.answers);
    if (!applied.ok) return { status: 400, fields: applied.fields };
    notes = applied.notes;
    contact = applied.contact;
  }
  const answers = { ...job.answers, contact: { ...job.answers.contact, ...contact } };
  const mustAnswer = job.questions.find((q) => q.id === job.requiredQuestion);
  const required: AnswersResult = { status: 400, fields: [mustAnswer?.id ?? ''], required: true };
  if (mustAnswer && !notes.some((note) => note.question === mustAnswer.label)) return required;

  const usage = [...job.usage];
  if (notes.length > 0) {
    const reject = async (rejectedBy: 'prescreen' | 'guardrail', rejectDetail: string): Promise<AnswersResult> => {
      await releaseNewSite(job, deps);
      await stores.updateJob(jobId, { status: 'REJECTED', rejectedBy, rejectDetail, notes, usage });
      await announceRejection(deps.announce, job, rejectedBy, rejectDetail);
      return { status: 422 };
    };
    try {
      const screening = await prescreen(answers, { callTool: deps.callTool, modelId: deps.prescreenModelId }, job.instruction, [...(job.notes ?? []), ...notes]);
      usage.push(screening.usage);
      if (isRejected(screening)) return reject('prescreen', screening.category);
      if (mustAnswer && isUnclear(screening)) return required;
    } catch (error) {
      if (error instanceof GuardrailBlocked) return reject('guardrail', 'answers');
      throw error;
    }
  }

  const moved = await stores.transitionJob(jobId, 'NEEDS_INPUT', {
    status: 'PENDING',
    stage: 'write',
    startedAt: deps.now(),
    answers,
    notes: [...(job.notes ?? []), ...notes],
    usage,
  });
  if (!moved) return { status: 409 }; // answered twice at once
  await deps.startGenerate(jobId);
  return { status: 202 };
}
