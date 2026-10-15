/**
 * Notices for the admin (the `SiteNotices` SNS topic; `./coyote.sh subscribe-alerts` subscribes to it): every new
 * site and every owner's change made by the page writer (Rediseñar, photos), with what it cost, every rejected
 * request or change, and every job that failed on our side, with what it spent before failing. Plain text. A failure is logged and never changes the outcome.
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
  /** Template mode: the template the page was filled from (`model` filled it). */
  template?: string;
  model: string;
  effort: string;
  skill: string;
  look: boolean;
  images: boolean;
  ownerImages: boolean;
}

const STEPS: Record<string, string> = { prescreen: 'pre-screen', plan_site: 'preguntas', write_page: 'página', edit_page: 'página', pick_template: 'plantilla', fill_page: 'página', make_image: 'fotos' };
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
  `${s.template ? `Plantilla: ${s.template}, llenada por ${s.model}` : `Redactor: ${s.model}, esfuerzo ${s.effort} · skill ${s.skill} · look ${s.look ? 'on' : 'off'}`} · fotos IA ${s.images ? 'on' : 'off'} (dueño: ${s.ownerImages ? 'on' : 'off'})`;

/** A new site's first draft is ready. */
export function announceNewSite(announce: Announce | undefined, job: Job, slug: string, draftUrl: string, usage: Usage[], status?: PageWriterStatus): Promise<void> {
  const { businessName, about, lang } = job.answers;
  const total = [...job.usage, ...usage];
  return send(announce, `Nuevo sitio: ${businessName}`, [
    `${businessName} (${slug}, ${lang})`,
    owner(job),
    `Borrador: ${draftUrl}`,
    ...costLines(total),
    ...(status ? [statusLine(status)] : []),
    tokenLine(total),
    '',
    about,
  ], job);
}

const tokenLine = (usage: Usage[]) => {
  const tokens = (k: 'inputTokens' | 'outputTokens') => usage.reduce((n, u) => n + u[k], 0);
  return `Modelos: ${[...new Set(usage.map((u) => u.modelId))].join(', ')}; ${tokens('inputTokens')} tokens de entrada, ${tokens('outputTokens')} de salida`;
};

/** What the owner changed in Mi sitio: "Fotos: 2 nuevas, 1 quitada, 1 descripción". */
function photoLine(change: Job['photoChange']): string | undefined {
  if (!change) return undefined;
  const parts = [
    change.added.length > 0 && `${change.added.length} ${change.added.length === 1 ? 'nueva' : 'nuevas'}`,
    change.removed.length > 0 && `${change.removed.length} ${change.removed.length === 1 ? 'quitada' : 'quitadas'}`,
    change.described?.length && `${change.described.length} ${change.described.length === 1 ? 'descripción' : 'descripciones'}`,
    change.replaced?.length && `${change.replaced.length} en lugar de ${change.replaced.length === 1 ? 'una creada' : 'creadas'} con IA, sin rediseño`,
  ].filter(Boolean);
  return parts.length > 0 ? `Fotos: ${parts.join(', ')}` : undefined;
}

/** An owner's change the page writer made (Rediseñar from Mi sitio or the chat, or a photo change): the new draft and its cost. */
/** What a redesign did with the texts the owner wrote (page-texts.ts `restoreTexts`), or with the owner's photos (`restorePhotos`). */
export interface OwnerTextsCount {
  kept: number;
  restored: number;
  lost: number;
}

export function announceEdit(announce: Announce | undefined, job: Job, slug: string, draftUrl: string, usage: Usage[], status?: PageWriterStatus, texts?: OwnerTextsCount, photoCount?: OwnerTextsCount): Promise<void> {
  const { businessName, lang } = job.answers;
  const total = [...job.usage, ...usage];
  const photos = photoLine(job.photoChange);
  const what = job.instruction ? 'Rediseño' : 'Cambio de fotos';
  return send(announce, `${what}: ${businessName}`, [
    `${businessName} (${slug}, ${lang})`,
    owner(job),
    `Borrador: ${draftUrl}`,
    ...(job.instruction ? [`Pedido: ${job.instruction}`] : []),
    ...(photos ? [photos] : []),
    ...(texts ? [`Textos del dueño: ${texts.kept} mantenidos, ${texts.restored} devueltos, ${texts.lost} perdidos`] : []),
    ...(photoCount ? [`Fotos del dueño: ${photoCount.kept} mantenidas, ${photoCount.restored} devueltas, ${photoCount.lost} perdidas`] : []),
    ...costLines(total),
    ...(status ? [statusLine(status)] : []),
    tokenLine(total),
  ], job);
}

/**
 * A job failed on our side (the page writer erred, a crash, a timeout): the error and what it had spent. A model call
 * that fails partway reports no tokens, so the cost is a floor, and a timeout loses the run's calls altogether.
 */
export function announceFailure(announce: Announce | undefined, job: Job, error: string, usage: Usage[] = [], timedOut = false): Promise<void> {
  const { businessName, lang } = job.answers;
  const edit = job.kind === 'edit';
  const total = [...job.usage, ...usage];
  const photos = photoLine(job.photoChange);
  return send(announce, `${edit ? 'Cambio falló' : 'Sitio falló'}: ${businessName}`, [
    `${businessName} (${job.slug ?? 'sin slug'}, ${lang})`,
    owner(job),
    `Error: ${error.slice(0, 500)}`,
    ...(edit && job.instruction ? [`Pedido: ${job.instruction}`] : []),
    ...(edit && photos ? [photos] : []),
    '',
    ...(total.length > 0 ? costLines(total) : ['Costo: $0.000']),
    timedOut
      ? 'No incluye lo que gastó la ejecución que se cortó (sus llamadas no quedaron registradas): con Opus, hasta ~$0.60 más.'
      : 'Una llamada que falló a mitad no deja registro de tokens: el costo real puede ser algo mayor.',
  ], job);
}

/**
 * A request or an owner's change was rejected (pre-screen, brand, guardrail, images, or the page checks). `usage`:
 * the model calls the rejected job made, so a page written and then refused still shows what it cost.
 */
export function announceRejection(announce: Announce | undefined, job: Job, rejectedBy: string, detail: string, usage: Usage[] = []): Promise<void> {
  const { businessName, about, lang } = job.answers;
  const edit = job.kind === 'edit';
  return send(announce, `${edit ? 'Cambio rechazado' : 'Sitio rechazado'}: ${businessName}`, [
    `${businessName} (${job.slug ?? 'sin slug'}, ${lang})`,
    owner(job),
    `Motivo: ${rejectedBy} — ${detail}`,
    ...(edit && job.instruction ? ['', `Pedido: ${job.instruction}`] : []),
    ...([...job.usage, ...usage].length > 0 ? ['', ...costLines([...job.usage, ...usage])] : []),
    '',
    about,
  ], job);
}
