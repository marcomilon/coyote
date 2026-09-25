import type { CallText, CallTool, TextRequest, ToolRequest } from '../src/core/bedrock';
import type { Question } from '../src/core/questions';

/** A page the way the model writes it: placeholders for every contact detail and image. */
export const MODEL_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panadería Luna — masa madre en Chapinero</title>
<meta name="description" content="Pan de masa madre horneado cada mañana en Chapinero.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Work+Sans&display=swap">
<style>
:root{--ink:#1f1a17;--paper:#f6efe4;--accent:#c2410c}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Work Sans",sans-serif}
.hero{min-height:60vh;background:url({{hero}}) center/cover}
h1{font-family:Fraunces,serif;text-wrap:balance}
.wa{position:fixed;right:1rem;bottom:1rem;background:var(--accent);color:#fff;padding:.9rem 1.2rem;border-radius:99px}
a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.map{height:280px;border-radius:16px;overflow:hidden}
@media (prefers-reduced-motion:no-preference){h1{animation:up .6s both}}
@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
</style>
</head>
<body>
<header class="hero"><img src="{{logo}}" alt="Panadería Luna" width="96" height="96"><h1>Pan de masa madre, cada mañana en Chapinero</h1></header>
<main>
<section id="pan"><h2>Nuestro pan</h2><p>Hogazas de 800 g, blancas e integrales.</p>
<svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true"><path d="M4 12c0-4 4-7 8-7s8 3 8 7v6H4z" fill="currentColor"/></svg></section>
<section id="visitanos"><h2>Visítanos</h2>
<address>{{address}}</address>
<a class="btn" href="{{maps_url}}" target="_blank">Cómo llegar</a>
<div class="map" data-slot="map"></div>
<ul>
<li data-needs="phone_url">Teléfono: <a href="{{phone_url}}">{{phone_display}}</a></li>
<li><a href="{{email_url}}">{{email_display}}</a></li>
<li><a href="{{instagram_url}}">Instagram</a></li>
</ul>
</section>
</main>
<a class="wa" href="{{whatsapp_url}}">Escríbenos por WhatsApp</a>
</body>
</html>`;

export const QUESTIONS: Question[] = [
  { id: 'servicios', label: '¿Qué productos vendes y a qué precio?', type: 'textarea' },
  { id: 'estilo', label: '¿Qué estilo te gusta?', type: 'choice', options: ['Moderno', 'Clásico', 'Colorido'] },
  { id: 'telefono', label: '¿Tienes un teléfono fijo?', type: 'phone' },
];

const usage = (step: string) => ({ step, modelId: 'test', inputTokens: 1, outputTokens: 1 });

export interface FakeModel {
  callTool: CallTool;
  callText: CallText;
  /** Tool names (and text steps) in call order. */
  calls: string[];
  /** Every request, for assertions on the prompt. */
  requests: (ToolRequest<never> | TextRequest)[];
}

/** A scripted model. Every option can be changed between calls. */
export function fakeModel(options: { classify?: 'allow' | 'reject'; questions?: Question[]; page?: string; heroScene?: string; edited?: string } = {}): FakeModel & { options: typeof options } {
  const calls: string[] = [];
  const requests: (ToolRequest<never> | TextRequest)[] = [];
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
        default:
          throw new Error(`unexpected tool ${request.tool.name}`);
      }
    })();
    return { value: request.tool.schema.parse(value), usage: usage(request.tool.name) };
  }) as CallTool;
  // The page comes back as text: an optional "Hero scene:" line, then the document in a ```html block.
  const callText = (async (request) => {
    calls.push(request.step);
    requests.push(request);
    const html = request.step === 'edit_site' ? (options.edited ?? (options.page ?? MODEL_PAGE).replace('Nuestro pan', 'Nuestro pan de cada día')) : (options.page ?? MODEL_PAGE);
    const text = `${options.heroScene ? `Hero scene: ${options.heroScene}\n\n` : ''}\`\`\`html\n${html}\n\`\`\``;
    return { text, usage: usage(request.step) };
  }) as CallText;
  return { callTool, callText, calls, requests, options };
}
