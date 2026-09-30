import type { PageRequest, WritePage } from '../src/core/page-writer';
import type { Brief } from '../src/core/brief';
import type { CallTool, ToolRequest } from '../src/core/bedrock';
import { SiteContent } from '../src/core/content';
import type { Question } from '../src/core/questions';

export const brief: Brief = {
  theme: 'editorial',
  palette: { ink: '#1f1a17', paper: '#f6efe4', accent: '#c2410c' },
  fontPairing: 'fraunces-worksans',
  tone: 'cálido y directo',
  signatureElement: 'Una franja gruesa color ladrillo bajo el nombre',
  headline: 'Pan de masa madre en Chapinero',
  heroScene: 'A small sourdough bakery in Bogotá at dawn, loaves on wooden shelves, flour on the counter',
};

export const content: SiteContent = SiteContent.parse({
  businessName: 'Panadería Luna',
  lang: 'es',
  title: 'Panadería Luna — pan de masa madre en Chapinero, Bogotá',
  description: 'Pan de masa madre horneado cada mañana en Chapinero.',
  headline: 'Pan de masa madre, cada mañana en Chapinero',
  subhead: 'Horneamos desde las 5 a. m. con harinas colombianas.',
  about: 'Somos una panadería de barrio en Chapinero.',
  services: [{ name: 'Pan de masa madre', detail: 'Hogazas de 800 g' }, { name: 'Café de origen' }],
  hours: [{ days: 'Lunes a sábado', time: '7:00 – 19:00' }],
  location: { neighborhood: 'Chapinero', city: 'Bogotá' },
  ctaText: 'Pide por WhatsApp',
  contact: { whatsapp: '573001234567', address: 'Calle 60 # 9-12', instagram: 'panaderia.luna' },
});

/** What the model writes for publish_content (the copy only). */
export const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;

export const QUESTIONS: Question[] = [
  { id: 'servicios', label: '¿Qué productos vendes y a qué precio?', type: 'textarea' },
  { id: 'estilo', label: '¿Qué estilo te gusta?', type: 'choice', options: ['Moderno', 'Clásico', 'Colorido'] },
  { id: 'telefono', label: '¿Tienes un teléfono fijo?', type: 'phone' },
];

const usage = (step: string) => ({ step, modelId: 'test', inputTokens: 1, outputTokens: 1 });

export interface FakeModelOptions {
  classify?: 'allow' | 'reject';
  questions?: Question[];
  /** Overrides for the publish_content copy. */
  copy?: Record<string, unknown>;
  /** The edit_content answer. */
  edit?: Record<string, unknown>;
  /** The chat's edit_page answer, or a function of the call number (1, 2, …). */
  chat?: Record<string, unknown> | ((call: number) => Record<string, unknown>);
}

/** A scripted model. Every option can be changed between calls. */
/**
 * A page writer that answers with a small page built from the request: the business name, a WhatsApp link to the
 * number it was given, and the change it was asked for. `page` replaces the page; `fail` makes it throw.
 */
export function fakeWriter(options: { page?: (request: PageRequest) => string; fail?: Error } = {}) {
  const requests: PageRequest[] = [];
  const writePage: WritePage = async (request) => {
    requests.push(request);
    if (options.fail) throw options.fail;
    const page =
      options.page?.(request) ??
      (request.current !== undefined
        ? request.current.replace('</main>', `<p>${request.instruction}</p></main>`)
        : `<!doctype html><html lang="${request.answers.lang}"><head><meta charset="utf-8"><title>${request.answers.businessName}</title></head><body><main><h1>${request.answers.businessName}</h1><p>${request.answers.about}</p><p>${'Pan recién horneado. '.repeat(20)}</p><a href="https://wa.me/${request.answers.contact.whatsapp}">WhatsApp</a></main></body></html>`);
    return { text: `\`\`\`html\n${page}\n\`\`\``, stopReason: 'end_turn', usage: { step: request.current !== undefined ? 'edit_page' : 'write_page', modelId: 'opus', inputTokens: 100, outputTokens: 1000 } };
  };
  return { writePage, requests, options };
}

export function fakeModel(options: FakeModelOptions = {}) {
  const calls: string[] = [];
  const requests: ToolRequest<never>[] = [];
  let chatCalls = 0;
  const callTool = (async (request) => {
    calls.push(request.tool.name);
    requests.push(request as ToolRequest<never>);
    const value = (() => {
      switch (request.tool.name) {
        case 'classify': {
          const reject = options.classify === 'reject';
          return { reason: 'x', decision: reject ? 'reject' : 'allow', category: reject ? 'adult' : 'ok', confidence: 0.95 };
        }
        case 'plan_site':
          return options.questions?.length ? { ready: false, questions: options.questions } : { ready: true };
        case 'design_brief':
          return brief;
        case 'publish_content':
          return { ...modelContent, ...options.copy };
        case 'edit_content':
          return options.edit ?? { headline: 'Pan de masa madre, también los domingos' };
        case 'edit_page': {
          chatCalls++;
          const chat = options.chat;
          return typeof chat === 'function' ? chat(chatCalls) : (chat ?? { action: 'none', reply: '¡Hola! ¿Qué quieres cambiar?' });
        }
        default:
          throw new Error(`unexpected tool ${request.tool.name}`);
      }
    })();
    // The brief's schema depends on the slug's theme candidates; fixBrief repairs a theme outside them.
    return { value: request.tool.name === 'design_brief' ? value : request.tool.schema.parse(value), usage: usage(request.tool.name) };
  }) as CallTool;
  return { callTool, calls, requests, options };
}
