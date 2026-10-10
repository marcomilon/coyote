import type { Lang } from './answers';
import type { ChatMessage, Job, Stores } from './jobs';

/**
 * The chat's own notes about what happened to the page: a redesign (in progress, then its outcome) and an undo.
 * They are stored in the chat like the replies, so a reload, or the chat on another device, shows them too.
 */

export const CHAT_TTL_SECONDS = 90 * 24 * 60 * 60;

const NOTES = {
  es: {
    redesigning: 'Rediseñando tu página web. Tarda 2–3 minutos; puedes dejar esta pantalla abierta.',
    redesigned: 'Listo: así quedó tu página web con el rediseño.',
    rejected: 'No puedo hacer ese cambio porque no cumple las reglas de uso.',
    failed: 'Algo salió mal y no pude rediseñar tu página web. Inténtalo de nuevo.',
    undone: 'Listo, volví a la versión anterior.',
  },
  pt: {
    redesigning: 'Redesenhando seu site. Leva 2–3 minutos; pode deixar esta tela aberta.',
    redesigned: 'Pronto: seu site ficou assim com o redesenho.',
    rejected: 'Não posso fazer essa mudança porque ela não segue as regras de uso.',
    failed: 'Algo deu errado e não consegui redesenhar seu site. Tente de novo.',
    undone: 'Pronto, voltei para a versão anterior.',
  },
} as const;

const ttl = (now: number) => Math.floor(now / 1000) + CHAT_TTL_SECONDS;

/** A redesign started: a pending note that names its job. Resolves to the note's `at`, kept on the job. */
export async function noteRedesign(stores: Pick<Stores, 'putChat'>, slug: string, jobId: string, lang: Lang, now: number): Promise<number> {
  await stores.putChat({ slug, at: now, role: 'coyote', text: NOTES[lang].redesigning, status: 'pending', jobId, ttl: ttl(now) });
  return now;
}

/** The redesign ended: its note says how, and a new draft makes it a change the owner can undo. Resolves to the change. */
export async function noteRedesignDone(stores: Pick<Stores, 'updateChat'>, job: Job, outcome: 'DONE' | 'REJECTED' | 'FAILED', draftId?: string): Promise<Partial<ChatMessage>> {
  if (!job.slug || job.chatAt === undefined) return {};
  const say = NOTES[job.answers.lang];
  const patch: Partial<ChatMessage> =
    outcome === 'DONE' ? { status: 'done', text: say.redesigned, ...(draftId && { draftId }) } : { status: 'failed', text: outcome === 'REJECTED' ? say.rejected : say.failed };
  await stores.updateChat(job.slug, job.chatAt, patch).catch((error: unknown) => console.warn('chat: redesign note not updated', { jobId: job.jobId, error }));
  return patch;
}

export async function noteUndo(stores: Pick<Stores, 'putChat'>, slug: string, lang: Lang, now: number): Promise<void> {
  await stores.putChat({ slug, at: now, role: 'coyote', text: NOTES[lang].undone, status: 'done', ttl: ttl(now) });
}
