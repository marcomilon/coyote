/**
 * Our emails: fixed subjects, plain text, in the owner's language. The business names are the only text the
 * owner wrote; no model output ever goes in an email. Sent through SES (`src/aws/mail.ts`).
 */
export interface Email {
  to: string;
  subject: string;
  text: string;
}
export type SendEmail = (email: Email) => Promise<void>;

const MAIL = {
  es: {
    loginSubject: 'Tus sitios en Coyote',
    login: (names: string[], link: string) =>
      `Hola:\n\nPediste entrar a tus sitios de Coyote:\n${names.map((n) => `- ${n}`).join('\n')}\n\nÁbrelos con este enlace (sirve una vez, durante una hora):\n${link}\n\nSi no fuiste tú, ignora este correo.\n\nCoyote`,
    readySubject: (name: string) => `Tu sitio está listo: ${name}`,
    ready: (name: string, link: string) =>
      `Hola:\n\nEl sitio de ${name} está listo. Míralo y pide cambios desde tu celular con este enlace (sirve una vez, durante una hora):\n${link}\n\nSi el enlace venció, pide uno nuevo en «Mis sitios» con este mismo correo.\n\nCoyote`,
  },
  pt: {
    loginSubject: 'Seus sites no Coyote',
    login: (names: string[], link: string) =>
      `Olá:\n\nVocê pediu para entrar nos seus sites do Coyote:\n${names.map((n) => `- ${n}`).join('\n')}\n\nAbra com este link (vale uma vez, por uma hora):\n${link}\n\nSe não foi você, ignore este e-mail.\n\nCoyote`,
    readySubject: (name: string) => `Seu site está pronto: ${name}`,
    ready: (name: string, link: string) =>
      `Olá:\n\nO site de ${name} está pronto. Veja e peça mudanças pelo celular com este link (vale uma vez, por uma hora):\n${link}\n\nSe o link vencer, peça outro em «Meus sites» com este mesmo e-mail.\n\nCoyote`,
  },
};

/** Names go in a subject: one line, short. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

export function loginEmail(to: string, lang: 'es' | 'pt', businessNames: string[], link: string): Email {
  const m = MAIL[lang];
  return { to, subject: m.loginSubject, text: m.login(businessNames.map(oneLine), link) };
}

export function readyEmail(to: string, lang: 'es' | 'pt', businessName: string, link: string): Email {
  const m = MAIL[lang];
  return { to, subject: m.readySubject(oneLine(businessName)), text: m.ready(oneLine(businessName), link) };
}
