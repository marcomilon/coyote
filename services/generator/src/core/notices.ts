/**
 * Notices for the admin (the `SiteNotices` SNS topic; `./coyote.sh subscribe-alerts` subscribes to it): every new
 * site, and every rejected request or change. Plain text. A failure is logged and never changes the outcome.
 */
import type { Usage } from './bedrock';
import type { Job } from './jobs';

export type Announce = (subject: string, message: string) => Promise<void>;

const subject = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 100);

async function send(announce: Announce | undefined, title: string, lines: string[], job: Job): Promise<void> {
  if (!announce) return;
  try {
    await announce(subject(title), lines.join('\n'));
  } catch (error) {
    console.error('admin notice failed', { jobId: job.jobId, error });
  }
}

const owner = (job: Job) => `Dueño: ${job.ownerEmail ?? '—'}`;

/** A new site's first draft is ready. */
export function announceNewSite(announce: Announce | undefined, job: Job, slug: string, draftUrl: string, usage: Usage[]): Promise<void> {
  const { businessName, about, lang } = job.answers;
  const total = [...job.usage, ...usage];
  const tokens = (k: 'inputTokens' | 'outputTokens') => total.reduce((n, u) => n + u[k], 0);
  return send(announce, `Nuevo sitio: ${businessName}`, [
    `${businessName} (${slug}, ${lang})`,
    owner(job),
    `Borrador: ${draftUrl}`,
    `Modelos: ${[...new Set(total.map((u) => u.modelId))].join(', ')}; ${tokens('inputTokens')} tokens de entrada, ${tokens('outputTokens')} de salida`,
    '',
    about,
  ], job);
}

/** A request or an owner's change was rejected (pre-screen, brand, guardrail, images, or the page checks). */
export function announceRejection(announce: Announce | undefined, job: Job, rejectedBy: string, detail: string): Promise<void> {
  const { businessName, about, lang } = job.answers;
  const edit = job.kind === 'edit';
  return send(announce, `${edit ? 'Cambio rechazado' : 'Sitio rechazado'}: ${businessName}`, [
    `${businessName} (${job.slug ?? 'sin slug'}, ${lang})`,
    owner(job),
    `Motivo: ${rejectedBy} — ${detail}`,
    ...(edit && job.instruction ? ['', `Pedido: ${job.instruction}`] : []),
    '',
    about,
  ], job);
}
