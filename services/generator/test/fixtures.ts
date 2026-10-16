import type { PageRequest, WritePage } from '../src/core/page-writer';
import type { CallTool, ToolRequest } from '../src/core/bedrock';
import type { Question } from '../src/core/questions';

export const QUESTIONS: Question[] = [
  { id: 'servicios', label: '¿Qué productos vendes y a qué precio?', type: 'textarea' },
  { id: 'estilo', label: '¿Qué estilo te gusta?', type: 'choice', options: ['Moderno', 'Clásico', 'Colorido'] },
  { id: 'telefono', label: '¿Tienes un teléfono fijo?', type: 'phone' },
];

const usage = (step: string) => ({ step, modelId: 'test', inputTokens: 1, outputTokens: 1 });

export interface FakeModelOptions {
  classify?: 'allow' | 'reject';
  /** The pre-screen's clarity (default: clear). */
  clarity?: 'clear' | 'thin' | 'unusable';
  /** The pre-screen's offers (default: true). */
  offers?: boolean;
  questions?: Question[];
  /** plan_site's `enough` when it asks (default: unset, so the questions can be skipped), and its offersQuestion. */
  enough?: boolean;
  offersQuestion?: string;
  /** The chat's edit_page answer, or a function of the call number (1, 2, …). */
  chat?: Record<string, unknown> | ((call: number) => Record<string, unknown>);
  /** Template mode: the template pick_template picks (default: the first), and fill_page's words. */
  pick?: string;
  fill?: Record<string, unknown>;
  /** check_hands: the photos (1, 2, …) whose hands are drawn wrong. */
  badHands?: number[];
}

/** A scripted model. Every option can be changed between calls. */
/**
 * A page writer that answers with a small page built from the request: the business name, a WhatsApp link to the
 * number it was given, and the change it was asked for (a new design is a new page with the request in it). `page` replaces the page; `fail` makes it throw.
 */
export function fakeWriter(options: { page?: (request: PageRequest, made: string[]) => string; fail?: Error; images?: string[]; useImages?: number } = {}) {
  const requests: PageRequest[] = [];
  const settings: Parameters<WritePage>[1][] = [];
  const writePage: WritePage = async (request, setting) => {
    requests.push(request);
    settings.push(setting);
    if (options.fail) throw options.fail;
    // `images`: scenes it asks make_image for; the page shows the first `useImages` it gets (all by default).
    const made: string[] = [];
    for (const description of setting.makeImage ? (options.images ?? []) : []) {
      const result = await setting.makeImage!({ description, aspect: '16:9' });
      if ('file' in result) made.push(result.file);
    }
    const imgs = made.slice(0, options.useImages ?? made.length).map((file) => `<img src="${file}" alt="">`).join('');
    const page =
      options.page?.(request, made) ??
      (request.current !== undefined
        ? request.current.replace('</main>', `<p>${request.instruction}</p>${imgs}</main>`)
        : `<!doctype html><html lang="${request.answers.lang}"><head><meta charset="utf-8"><title>${request.answers.businessName}</title></head><body><main><h1>${request.answers.businessName}</h1>${imgs}<p>${request.answers.about}</p><p>${'Pan recién horneado. '.repeat(20)}</p>${request.instruction ? `<p>${request.instruction}</p>` : ''}<a href="https://wa.me/${request.answers.contact.whatsapp}">WhatsApp</a></main></body></html>`);
    return { text: `\`\`\`html\n${page}\n\`\`\``, stopReason: 'end_turn', usage: { step: request.current !== undefined ? 'edit_page' : 'write_page', modelId: 'opus', inputTokens: 100, outputTokens: 1000 } };
  };
  return { writePage, requests, settings, options };
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
          return { reason: 'x', decision: reject ? 'reject' : 'allow', category: reject ? 'adult' : 'ok', confidence: 0.95, clarity: options.clarity ?? 'clear', offers: options.offers ?? true };
        }
        case 'plan_site':
          return options.questions?.length ? { ready: false, enough: options.enough, offersQuestion: options.offersQuestion, questions: options.questions } : { ready: true };
        case 'edit_page': {
          chatCalls++;
          const chat = options.chat;
          return typeof chat === 'function' ? chat(chatCalls) : (chat ?? { action: 'none', reply: '¡Hola! ¿Qué quieres cambiar?' });
        }
        case 'pick_template':
          return { id: options.pick };
        case 'fill_page':
          return options.fill;
        case 'check_hands':
          return { handsVisible: true, handDrawnWrong: (options.badHands ?? []).includes(calls.filter((name) => name === 'check_hands').length) };
        default:
          throw new Error(`unexpected tool ${request.tool.name}`);
      }
    })();
    return { value: request.tool.schema.parse(value), usage: usage(request.tool.name) };
  }) as CallTool;
  return { callTool, calls, requests, options };
}
