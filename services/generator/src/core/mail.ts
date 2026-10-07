/**
 * Our emails: fixed subjects and copy in the owner's language, sent as branded HTML with a plain-text version.
 * The business names are the only text the owner wrote (escaped in the HTML); no model output ever goes in an
 * email. Sent through SES (`src/aws/mail.ts`).
 */
import { escapeHtml as e } from './html';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export type SendEmail = (email: Email) => Promise<void>;

/** One email's content; the text and HTML versions are both built from it. */
interface Content {
  lang: 'es' | 'pt';
  greeting: string;
  lead: string;
  /** Business names, as a list under the lead. */
  names?: string[];
  button: string;
  link: string;
  /** How long the link works. */
  validity: string;
  note: string;
}

const MAIL = {
  es: {
    greeting: 'Hola:',
    validity: 'El botón sirve una vez, durante una hora.',
    loginSubject: 'Tus sitios en ventas314.com',
    loginLead: 'Pediste entrar a tus sitios de ventas314.com:',
    loginButton: 'Entrar a mis sitios',
    loginNote: 'Si no fuiste tú, ignora este correo.',
    readySubject: (name: string) => `Tu sitio está listo: ${name}`,
    readyLead: (name: string) => `El sitio de ${name} está listo. Míralo y pide cambios desde tu celular.`,
    readyButton: 'Ver mi sitio',
    readyNote: 'Si el botón venció, pide un enlace nuevo en «Mis sitios» con este mismo correo.',
    footer: 'Ponemos tu negocio online.',
    fallback: '¿El botón no funciona? Copia este enlace en tu navegador:',
  },
  pt: {
    greeting: 'Olá:',
    validity: 'O botão vale uma vez, por uma hora.',
    loginSubject: 'Seus sites em ventas314.com',
    loginLead: 'Você pediu para entrar nos seus sites de ventas314.com:',
    loginButton: 'Entrar nos meus sites',
    loginNote: 'Se não foi você, ignore este e-mail.',
    readySubject: (name: string) => `Seu site está pronto: ${name}`,
    readyLead: (name: string) => `O site de ${name} está pronto. Veja e peça mudanças pelo celular.`,
    readyButton: 'Ver meu site',
    readyNote: 'Se o botão vencer, peça um link novo em «Meus sites» com este mesmo e-mail.',
    footer: 'Colocamos seu negócio online.',
    fallback: 'O botão não funciona? Copie este link no navegador:',
  },
};

/** Names go in a subject: one line, short. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);

function text(c: Content): string {
  const names = c.names?.length ? `\n${c.names.map((n) => `- ${n}`).join('\n')}\n` : '';
  return `${c.greeting}\n\n${c.lead}\n${names}\n${c.button}: ${c.link}\n${c.validity}\n\n${c.note}\n\nventas314.com — ${MAIL[c.lang].footer}`;
}

// The app's look in email-safe HTML: tables, inline styles, system fonts, and the logo hosted by the app.
const INK = '#1b1712';
const PAPER = '#f4ead5';
const CARD = '#fffaf0';
const ROJO = '#d7321f';

function html(c: Content, appUrl: string): string {
  const m = MAIL[c.lang];
  const font = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  const names = c.names?.length
    ? `<ul style="margin:0 0 20px;padding-left:20px">${c.names.map((n) => `<li style="margin:4px 0;font-weight:700">${e(n)}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="${c.lang === 'pt' ? 'pt-BR' : 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>ventas314.com</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
    <tr><td style="height:10px;background:repeating-linear-gradient(90deg,${ROJO} 0 24px,${PAPER} 24px 48px);background-color:${ROJO};border-radius:6px 6px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="background:${CARD};border:3px solid ${INK};border-top:0;border-radius:0 0 8px 8px;padding:28px 28px 24px;${font};color:${INK};font-size:16px;line-height:1.55">
      <a href="${e(appUrl)}/" style="display:inline-block;margin-bottom:20px"><img src="${e(appUrl)}/logo.png" width="200" height="40" alt="ventas314.com" style="display:block;border:0;width:200px;height:auto"></a>
      <p style="margin:0 0 12px">${e(c.greeting)}</p>
      <p style="margin:0 0 16px">${e(c.lead)}</p>
      ${names}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 10px"><tr><td style="background:${ROJO};border:3px solid ${INK};border-radius:8px;box-shadow:3px 3px 0 ${INK}">
        <a href="${e(c.link)}" style="display:inline-block;padding:14px 24px;color:${CARD};text-decoration:none;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:15px">${e(c.button)}</a>
      </td></tr></table>
      <p style="margin:0 0 18px;font-size:13px;opacity:.75">${e(c.validity)}</p>
      <p style="margin:0 0 18px">${e(c.note)}</p>
      <p style="margin:0;padding-top:14px;border-top:2px dashed ${INK};font-size:12px;opacity:.7">${e(m.fallback)}<br><a href="${e(c.link)}" style="color:${INK};word-break:break-all">${e(c.link)}</a></p>
    </td></tr>
    <tr><td style="padding:14px 4px;${font};color:${INK};font-size:12px;opacity:.7;text-align:center">ventas314.com — ${e(m.footer)}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const build = (to: string, subject: string, c: Content, appUrl: string): Email => ({ to, subject, text: text(c), html: html(c, appUrl) });

/** `appUrl`: our app (urls.ts), which hosts the logo and the home page the logo links to. */
export function loginEmail(to: string, lang: 'es' | 'pt', businessNames: string[], link: string, appUrl: string): Email {
  const m = MAIL[lang];
  return build(to, m.loginSubject, { lang, greeting: m.greeting, lead: m.loginLead, names: businessNames.map(oneLine), button: m.loginButton, link, validity: m.validity, note: m.loginNote }, appUrl);
}

export function readyEmail(to: string, lang: 'es' | 'pt', businessName: string, link: string, appUrl: string): Email {
  const m = MAIL[lang];
  const name = oneLine(businessName);
  return build(to, m.readySubject(name), { lang, greeting: m.greeting, lead: m.readyLead(name), button: m.readyButton, link, validity: m.validity, note: m.readyNote }, appUrl);
}
