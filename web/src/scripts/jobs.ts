// Job polling, shared by the create page and Mi sitio.
import type { Question } from './questions';

export interface JobView {
  status: 'PENDING' | 'NEEDS_INPUT' | 'DONE' | 'REJECTED' | 'FAILED';
  kind?: 'create' | 'edit';
  questions?: Question[];
  draftUrl?: string;
  /** A new site's magic link. Returned once, by the first read after DONE. */
  miSitioUrl?: string;
  ownerWhatsApp?: string;
}

const POLL_MS = 3000;
/** Generation times out at 10 minutes; the API reports FAILED after 12. */
const POLL_LIMIT_MS = 13 * 60 * 1000;

export const apiUrl = (new URLSearchParams(location.search).get('api') ?? window.COYOTE_CONFIG?.apiUrl ?? '').replace(/\/+$/, '');

export async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl + path, init);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

/** Resolves when the job leaves PENDING, or to FAILED after the limit. */
export async function waitForJob(jobId: string): Promise<JobView> {
  const started = Date.now();
  while (Date.now() - started < POLL_LIMIT_MS) {
    try {
      const { status, body } = await api<JobView>(`/jobs/${jobId}`);
      if (status === 404) break;
      if (status === 200 && body.status !== 'PENDING') return body;
    } catch {
      // A dropped connection is normal on mobile: keep trying until the limit.
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
  }
  return { status: 'FAILED' };
}

/** POST /jobs/{id}/answers: the answers, or skip ("Generar así"). */
export function sendAnswers(jobId: string, body: { answers: Record<string, string | string[]> } | { skip: true }) {
  return api<{ fields?: string[] }>(`/jobs/${jobId}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
