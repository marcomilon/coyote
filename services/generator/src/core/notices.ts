/**
 * Notices for the admin (the `SiteNotices` SNS topic; `./coyote.sh subscribe-alerts` subscribes to it): every new
 * site, and every rejected request or change. Plain text. A failure is logged and never changes the outcome.
 */
import type { Usage } from './bedrock';
import type { Job } from './jobs';
import { usageCost } from './models';

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

/** The page writer's settings for a job: the switches the generate Lambda read for it, and the owner's photo choice. */
export interface PageWriterStatus {
  model: string;
  effort: string;
  skill: string;
  look: boolean;
  images: boolean;
  ownerImages: boolean;
}

const STEPS: Record<string, string> = { prescreen: 'pre-screen', plan_site: 'preguntas', write_page: 'página', edit_page: 'página', make_image: 'fotos' };
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;

/** "Costo: $0.83" and one line per step (model prices only; Rekognition, the guardrail and Lambda are left out). */
function costLines(usage: Usage[]): string[] {
  const steps = new Map<string, { models: Set<string>; cost: number; unknown: boolean; count: number }>();
  for (const u of usage) {
    const label = STEPS[u.step] ?? u.step;
    const step = steps.get(label) ?? { models: new Set(), cost: 0, unknown: false, count: 0 };
    const cost = usageCost(u);
    step.models.add(u.modelId);
    step.count++;
    if (cost === undefined) step.unknown = true;
    else step.cost += cost;
    steps.set(label, step);
  }
  const total = [...steps.values()].reduce((n, s) => n + s.cost, 0);
  const unknown = [...steps.values()].some((s) => s.unknown);
  return [
    `Costo: ${usd(total)}${unknown ? ' + desconocido' : ''}`,
    ...[...steps].map(([label, s]) => `  ${label} (${label === 'fotos' ? `${s.count} × ` : ''}${[...s.models].join(', ')}): ${s.unknown ? 'precio desconocido' : usd(s.cost)}`),
  ];
}

const statusLine = (s: PageWriterStatus) =>
  `Redactor: ${s.model}, esfuerzo ${s.effort} · skill ${s.skill} · look ${s.look ? 'on' : 'off'} · fotos IA ${s.images ? 'on' : 'off'} (dueño: ${s.ownerImages ? 'on' : 'off'})`;

/** A new site's first draft is ready. */
export function announceNewSite(announce: Announce | undefined, job: Job, slug: string, draftUrl: string, usage: Usage[], status?: PageWriterStatus): Promise<void> {
  const { businessName, about, lang } = job.answers;
  const total = [...job.usage, ...usage];
  const tokens = (k: 'inputTokens' | 'outputTokens') => total.reduce((n, u) => n + u[k], 0);
  return send(announce, `Nuevo sitio: ${businessName}`, [
    `${businessName} (${slug}, ${lang})`,
    owner(job),
    `Borrador: ${draftUrl}`,
    ...costLines(total),
    ...(status ? [statusLine(status)] : []),
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
