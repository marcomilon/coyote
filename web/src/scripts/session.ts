// The "Mis sitios" session kept in this browser (account.ts on the API): `@<id>.<secret>`, 30 days.
import { forgetOwnerTokens } from './owner-token';

export interface Session {
  token: string;
  expiresAt: number;
}

const SESSION_KEY = 'coyote:session';

export function readSession(): Session | undefined {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    return session && session.expiresAt > Date.now() ? session : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(session: Session | undefined) {
  if (!session) forgetOwnerTokens('sessions'); // the sites opened with it, kept by owner-token.ts
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the session lasts as long as this page.
  }
}
