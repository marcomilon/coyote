/**
 * Makes page templates for template mode (`./coyote.sh page-mode template`) and tries them: Opus designs each
 * template with the frontend-design skill, then Haiku on Bedrock fills it for a few example businesses, exactly as
 * the generate Lambda does (template-writer.ts, page checks), and a gallery shows the results with their cost.
 *   npm run templates:make -w services/generator -- [--count 5] [--tones "Swiss/international,soft/pastel"]
 *     [--only colombia-arepas,peru-inmobiliaria,mx-taller] [--images on] [--concurrency 5] [--out out/templates/<name>]
 *   npm run templates:make -w services/generator -- --fill-only out/templates/<run>   (fill the run's templates again, no Opus)
 *   npm run templates:make -w services/generator -- --fill-only services/generator/templates   (try the library)
 * Writes <out>/templates/<id>.html (the templates), <out>/pages/<id>/<business>/index.html and <out>/index.html.
 * Add a good one to the library with: ./coyote.sh page-templates add <id> <out>/templates/<id>.html "<description>"
 * Real calls: about $0.50–0.80 a template on Opus, a few cents a filled page on Haiku (plus $0.04 a made photo with --images on).
 */
import Anthropic from '@anthropic-ai/sdk';
import { DetectModerationLabelsCommand, DetectTextCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeAnswers, type Answers, type PageGoal } from '../src/core/answers';
import { callTool, outputAllowed, stabilityImage, type Usage } from '../src/core/bedrock';
import { ownerText } from '../src/core/drafts';
import { DEFAULT_PAGE_SKILL } from '../src/core/frontend-design';
import { imageMaker, legibleWords } from '../src/core/images';
import { IMAGE_PRICE, imageModelId, modelId, usageCost } from '../src/core/models';
import { checkPage } from '../src/core/page-check';
import { anthropicApiKey, PAGE_MODELS, parsePage, TONES, type PagePhoto } from '../src/core/page-writer';
import type { Note } from '../src/core/questions';
import { parseTemplate } from '../src/core/template';
import { writeTemplatePage, type TemplateInfo } from '../src/core/template-writer';

process.env.AWS_PROFILE ??= 'coyote';

const repo = new URL('../../../', import.meta.url).pathname;
const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '5' },
    tones: { type: 'string' },
    only: { type: 'string', default: 'colombia-arepas,peru-inmobiliaria,mx-taller' },
    images: { type: 'string', default: 'off' },
    concurrency: { type: 'string', default: '5' },
    out: { type: 'string' },
    'fill-only': { type: 'string' },
  },
});

/**
 * The placeholder contract: the one place with rules for Opus, because a template is a different job from a page.
 * Kept short and about the slots only; the design is the skill's.
 */
const CONTRACT = `It is a template: our code fills in the words, the photos and the contact links for each business, so mark those places with these attributes. Fill it with realistic sample content for a typical business so it looks finished as it is.

- data-text="<name>" data-max="<characters>" on an element that holds only text (no child elements). Name it by its role (hero_title, hero_subtitle, about, cta_text, …). Add data-optional when the section can do without it. Use data-text="business_name" wherever the business name appears and data-text="address" for the address; our code fills both.
- Required: data-text="hero_title" and data-text="about".
- A list (services, products, reasons, steps; no testimonials or reviews, they would be invented): put data-repeat="<name>" data-min="<n>" data-max="<n>" on each item (min 1, max 12); the first item is the pattern, the others are samples. Inside an item, the texts are data-text fields named by role (title, text, price…). No images inside list items.
- Photos: data-image="<name>" data-aspect="<16:9|3:2|1:1|2:3|9:16>" on a wrapper element with a fixed size or aspect ratio and overflow hidden. Inside it, draw a fallback with CSS or inline SVG that looks good on its own: our code replaces it with an <img> that fills the wrapper (object-fit: cover) when there is a photo. Use 2 to 4 photo slots. data-image="logo" is where the business's logo goes (removed when there is none).
- Contact links: <a data-contact="whatsapp|phone|email|instagram|facebook|maps"> (maps opens Google Maps at the address). Our code sets the href; add data-contact-label when the link text should be the number, address or handle itself. A WhatsApp link is required. A link for a detail the business doesn't have is removed; put data-if="<kind>" on a block (e.g. the email row, the address section) that should go with it. data-if also takes a slot name (a data-text, data-repeat or data-image name), for a section that goes when that slot is empty.
- The main call to action: write alternatives side by side with data-goal="whatsapp", "call", "visit" (opens the map), "book" (a WhatsApp link); our code keeps one. Each is also a data-contact link.
- No forms, no outside images, no other links. Our code writes the <title>, the meta description and the structured data, and adds a small footer.
- Everything visible in Spanish (Latin America).`;

function templatePrompt(tone: string, dark: boolean): string {
  return `Use the ${DEFAULT_PAGE_SKILL.name} skill to create a one-page website template for a small business in Latin America (a bakery, a hair salon, a plumber, a real estate agent, a restaurant: any of them), as a single HTML file. For the look, go with ${tone}, on a ${dark ? 'dark' : 'light'} background, without a scrolling ticker or marquee strip.

${CONTRACT}

Reply with the complete HTML file.`;
}

interface Business {
  id: string;
  answers: Answers;
  notes: Note[];
  photos: (PagePhoto & { source: string })[];
}

function business(id: string): Business {
  const file = resolve(repo, 'examples', `${id}.json`);
  if (!existsSync(file)) throw new Error(`no examples/${id}.json`);
  const { form, details, goal, photos } = JSON.parse(readFileSync(file, 'utf8')) as {
    form: Parameters<typeof normalizeAnswers>[0];
    details?: string;
    goal?: PageGoal;
    photos?: { logo?: string; photos?: { file: string; caption?: string }[] };
  };
  const photo = (source: string, name: string, caption?: string) => {
    const path = resolve(repo, source);
    const mediaType = /\.png$/i.test(source) ? ('image/png' as const) : ('image/jpeg' as const);
    return { file: `assets/${name}.${mediaType === 'image/png' ? 'png' : 'jpg'}`, ...(caption && { caption }), bytes: readFileSync(path), mediaType, source: path };
  };
  return {
    id,
    answers: { ...normalizeAnswers(form), aiImages: values.images === 'on', ...(goal && { goal }) },
    notes: details ? [{ question: 'More details:', answer: details }] : [],
    photos: [...(photos?.logo ? [photo(photos.logo, 'logo')] : []), ...(photos?.photos ?? []).map((p, i) => photo(p.file, `photo-${i + 1}`, p.caption))],
  };
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
// --fill-only: an earlier run (its templates/ folder), or a folder of templates such as the library.
const cwd = process.env.INIT_CWD ?? process.cwd(); // npm -w runs the script in the workspace: paths are the caller's
const fillOnly = values['fill-only'] && resolve(cwd, values['fill-only']);
const earlierRun = fillOnly && existsSync(resolve(fillOnly, 'templates')) ? fillOnly : undefined;
const outDir = earlierRun ?? (values.out ? resolve(cwd, values.out) : resolve(repo, `out/templates/${stamp}`));
const templatesDir = fillOnly && !earlierRun ? fillOnly : resolve(outDir, 'templates');
const templateFile = (id: string) => resolve(templatesDir, `${id}.html`);
const businesses = values.only!.split(',').map((s) => business(s.trim()));
const concurrency = Number(values.concurrency);

/** Runs the jobs `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

interface Made {
  id: string;
  tone: string;
  dark: boolean;
  errors: string[];
  cost: number;
  seconds: number;
  error?: string;
}

/** Opus designs one template. A template that breaks the contract gets one round to fix it. */
async function design(client: Anthropic, n: number, tone: string, dark: boolean): Promise<Made> {
  const id = `t${n}-${tone.replace(/[^a-z]+/gi, '-').toLowerCase().replace(/-$/, '')}${dark ? '-dark' : ''}`;
  const started = Date.now();
  const model = PAGE_MODELS.opus;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: templatePrompt(tone, dark) }];
  let cost = 0;
  try {
    for (let round = 0; round < 2; round++) {
      const message = await client.messages.stream({ model, max_tokens: 64000, system: DEFAULT_PAGE_SKILL.text, messages, output_config: { effort: 'high' } } as Anthropic.MessageStreamParams).finalMessage();
      cost += usageCost({ step: 'template', modelId: model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }) ?? 0;
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const html = parsePage(text);
      if (!html) throw new Error(`no HTML in the reply (stop: ${message.stop_reason})`);
      const { errors } = parseTemplate(html);
      writeFileSync(resolve(outDir, 'templates', `${id}.html`), html);
      if (errors.length === 0 || round === 1) return { id, tone, dark, errors, cost, seconds: (Date.now() - started) / 1000 };
      console.log(`${id}: fixing ${errors.join('; ')}`);
      messages.push({ role: 'assistant', content: message.content.filter((b) => b.type === 'text') }, { role: 'user', content: `The template breaks the placeholder rules:\n- ${errors.join('\n- ')}\nFix only that and reply with the complete HTML file.` });
    }
    throw new Error('unreachable');
  } catch (error) {
    return { id, tone, dark, errors: [], cost, seconds: (Date.now() - started) / 1000, error: String(error).slice(0, 300) };
  }
}

interface Filled {
  template: string;
  business: string;
  page?: string;
  cost: number;
  made: number;
  seconds: number;
  violations: string[];
  error?: string;
}

const rekognition = new RekognitionClient({ region: 'us-east-1' });
const REFUSED = new Set(['Explicit', 'Non-Explicit Nudity of Intimate parts and Kissing', 'Violence', 'Visually Disturbing', 'Hate Symbols', 'Drugs & Tobacco', 'Gambling']);
const generateImage = stabilityImage(imageModelId());

/** Haiku fills one template for one business, as the generate Lambda does. */
async function fill(id: string, b: Business): Promise<Filled> {
  const dir = resolve(outDir, 'pages', id, b.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, 'assets'), { recursive: true });
  for (const p of b.photos) copyFileSync(p.source, resolve(dir, p.file));
  const html = readFileSync(templateFile(id), 'utf8');
  const made: string[] = [];
  const makeImage =
    values.images === 'on'
      ? imageMaker(
          `${dir}/`,
          {
            stores: { putAsset: async (file, bytes) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, bytes)), deletePrefix: async (file) => rmSync(file, { force: true }) },
            generateImage,
            moderate: async (file) => [
              ...new Set(
                ((await rekognition.send(new DetectModerationLabelsCommand({ Image: { Bytes: readFileSync(file) }, MinConfidence: 70 }))).ModerationLabels ?? [])
                  .map((l) => l.ParentName || l.Name || '')
                  .filter((n) => REFUSED.has(n)),
              ),
            ],
            readText: async (file) => legibleWords((await rekognition.send(new DetectTextCommand({ Image: { Bytes: readFileSync(file) } }))).TextDetections ?? []),
            outputAllowed: (text) => outputAllowed(text),
          },
          made,
        )
      : undefined;
  const started = Date.now();
  const photos = b.photos.map(({ source: _source, ...p }) => p);
  const media = { ...(photos.find((p) => p.file.startsWith('assets/logo')) && { logo: photos.find((p) => p.file.startsWith('assets/logo'))!.file }), photos: photos.filter((p) => !p.file.startsWith('assets/logo')).map((p) => p.file), captions: Object.fromEntries(photos.flatMap((p) => (p.caption ? [[p.file, p.caption]] : []))) };
  let usage: Usage[] = [];
  try {
    const written = await writeTemplatePage(
      { answers: b.answers, notes: b.notes, media, photos, ...(makeImage && { makeImage }) },
      { callTool, modelId: modelId(), templates: { list: async () => [{ id, description: '' }], get: async () => html } },
    );
    usage = written.usage;
    const checked = checkPage(written.page, {
      contact: b.answers.contact,
      ownerText: ownerText({ answers: b.answers, notes: b.notes, media }),
      businessName: b.answers.businessName,
      lang: b.answers.lang,
      homeUrl: 'https://app.example/',
      reportUrl: 'https://app.example/reportar',
      privacyUrl: 'https://app.example/privacidad',
    });
    writeFileSync(resolve(dir, 'index.html'), checked.html);
    writeFileSync(resolve(dir, 'fill.json'), `${JSON.stringify(written.template.fill, null, 2)}\n`);
    const cost = usage.reduce((n, u) => n + (usageCost(u) ?? 0), 0) + made.length * IMAGE_PRICE;
    return { template: id, business: b.id, page: `pages/${id}/${b.id}/index.html`, cost, made: made.length, seconds: (Date.now() - started) / 1000, violations: checked.violations.map((v) => `${v.code}: ${v.detail}`) };
  } catch (error) {
    return { template: id, business: b.id, cost: usage.reduce((n, u) => n + (usageCost(u) ?? 0), 0), made: made.length, seconds: (Date.now() - started) / 1000, violations: [], error: String(error).slice(0, 300) };
  }
}

mkdirSync(resolve(outDir, 'templates'), { recursive: true });
let designed: Made[] = [];
let ids: string[];
if (fillOnly) {
  const index = resolve(templatesDir, 'index.json');
  ids = existsSync(index)
    ? (JSON.parse(readFileSync(index, 'utf8')) as TemplateInfo[]).map((t) => t.id)
    : readdirSync(templatesDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
  ids = ids.filter((id) => parseTemplate(readFileSync(templateFile(id), 'utf8')).errors.length === 0);
  if (existsSync(resolve(outDir, 'designed.json'))) designed = JSON.parse(readFileSync(resolve(outDir, 'designed.json'), 'utf8')) as Made[];
} else {
  const count = Number(values.count);
  const pool_ = values.tones ? values.tones.split(',').map((s) => s.trim()) : [...TONES].sort(() => Math.random() - 0.5);
  const picks = Array.from({ length: count }, (_, i) => ({ n: i + 1, tone: pool_[i % pool_.length]!, dark: i % 3 === 2 }));
  console.log(`${count} templates with Opus → ${outDir}`);
  const client = new Anthropic({ apiKey: await anthropicApiKey(process.env), maxRetries: 2 });
  designed = await pool(picks, concurrency, async ({ n, tone, dark }) => {
    const made = await design(client, n, tone, dark);
    console.log(`${made.id}: ${made.error ?? (made.errors.length ? `UNUSABLE (${made.errors.join('; ')})` : 'ok')}, $${made.cost.toFixed(2)}, ${Math.round(made.seconds)} s`);
    return made;
  });
  writeFileSync(resolve(outDir, 'designed.json'), `${JSON.stringify(designed, null, 2)}\n`);
  ids = designed.filter((d) => !d.error && d.errors.length === 0).map((d) => d.id);
}

const jobs = ids.flatMap((id) => businesses.map((b) => ({ id, b })));
console.log(`${jobs.length} pages filled by ${modelId()}`);
const filled = await pool(jobs, concurrency, async ({ id, b }) => {
  const r = await fill(id, b);
  console.log(`${id} · ${b.id}: ${r.error ?? (r.violations.length ? `REJECTED (${r.violations.join('; ')})` : 'passes')}, $${r.cost.toFixed(3)}${r.made ? ` (${r.made} photos)` : ''}, ${Math.round(r.seconds)} s`);
  return r;
});
writeFileSync(resolve(outDir, 'filled.json'), `${JSON.stringify(filled, null, 2)}\n`);
writeFileSync(resolve(outDir, 'index.html'), gallery());
const designCost = designed.reduce((n, d) => n + d.cost, 0);
const fills = filled.filter((f) => !f.error);
console.log(`Templates $${designCost.toFixed(2)}; filled pages $${(fills.reduce((n, f) => n + f.cost, 0) / Math.max(fills.length, 1)).toFixed(3)} each on average. ${resolve(outDir, 'index.html')}`);

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function gallery(): string {
  const sections = ids
    .map((id) => {
      const d = designed.find((x) => x.id === id);
      const rel = templateFile(id).startsWith(outDir) ? templateFile(id).slice(outDir.length + 1) : templateFile(id);
      const cards = filled
        .filter((f) => f.template === id)
        .map(
          (f) => `<article class="card"><header><h3>${esc(f.business)}</h3><span class="pill ${f.error || f.violations.length ? 'bad' : 'ok'}">${f.error ? 'Failed' : f.violations.length ? 'Rejected' : 'Passes checks'}</span></header>
  ${f.page ? `<div class="shot"><iframe src="${f.page}" loading="lazy" tabindex="-1" title="${esc(`${id}, ${f.business}`)}"></iframe></div>` : `<div class="shot empty"><p>${esc(f.error ?? 'No page')}</p></div>`}
  <p class="facts">$${f.cost.toFixed(3)}${f.made ? ` · ${f.made} photos` : ''} · ${Math.round(f.seconds)} s</p>
  ${f.violations.length ? `<ul class="notes">${f.violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}
  <p class="links">${f.page ? `<a href="${f.page}" target="_blank" rel="noopener">Open page</a><a href="${f.page.replace('index.html', 'fill.json')}" target="_blank" rel="noopener">Words</a>` : ''}</p></article>`,
        )
        .join('');
      return `<section><h2>${esc(id)}${d ? `<span>${esc(d.tone)} · ${d.dark ? 'dark' : 'light'} · $${d.cost.toFixed(2)} · ${Math.round(d.seconds)} s</span>` : ''}</h2><p class="links"><a href="${esc(rel)}" target="_blank" rel="noopener">The template</a></p><div class="grid">${cards}</div></section>`;
    })
    .join('');
  const broken = designed.filter((d) => d.error || d.errors.length).map((d) => `<li>${esc(d.id)}: ${esc(d.error ?? d.errors.join('; '))}</li>`).join('');
  return `<title>Template Bench ${stamp}</title>
<style>
:root { --bg: #f3f4f1; --surface: #fff; --fg: #1b1d1a; --muted: #62675f; --line: #d9dcd4; --accent: #2b50c8; --ok: #1f7a4a; --ok-bg: #e2f2e8; --bad: #b3261e; --bad-bg: #fbe6e4 }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #131512; --surface: #1c1f1b; --fg: #e8eae4; --muted: #9aa094; --line: #30342e; --accent: #8ea6ff; --ok: #7fd6a3; --ok-bg: #173323; --bad: #ff9a8f; --bad-bg: #3a1b18; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #131512; --surface: #1c1f1b; --fg: #e8eae4; --muted: #9aa094; --line: #30342e; --accent: #8ea6ff; --ok: #7fd6a3; --ok-bg: #173323; --bad: #ff9a8f; --bad-bg: #3a1b18; color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 }
main { max-width: 1440px; margin: 0 auto; padding: 32px 16px 64px; display: grid; gap: 40px }
h1, h2, h3 { margin: 0 }
h2 { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline }
h2 span, .facts { font: 13px ui-monospace, Menlo, monospace; color: var(--muted); margin: 0 }
section { display: grid; gap: 12px }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 20px }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px; display: grid; gap: 10px; align-content: start; min-width: 0 }
.card header { display: flex; justify-content: space-between; gap: 8px }
.pill { font-size: 12px; padding: 2px 10px; border-radius: 999px }
.pill.ok { color: var(--ok); background: var(--ok-bg) } .pill.bad { color: var(--bad); background: var(--bad-bg) }
.shot { position: relative; aspect-ratio: 4 / 5; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: #fff }
.shot iframe { position: absolute; top: 0; left: 0; width: 1280px; height: 1600px; border: 0; transform-origin: 0 0; pointer-events: none }
.shot.empty { display: grid; place-items: center; background: var(--bad-bg); color: var(--bad); padding: 16px; font-size: 13px }
.notes { margin: 0; padding-left: 18px; font-size: 13px; color: var(--bad); overflow-wrap: anywhere }
.links { margin: 0; display: flex; gap: 16px; font-size: 14px }
a { color: var(--accent) }
</style>
<main>
  <header><h1>Template bench</h1><p class="facts">Run ${stamp} · filled by ${esc(modelId())} · templates $${designed.reduce((n, d) => n + d.cost, 0).toFixed(2)}</p>${broken ? `<ul class="notes">${broken}</ul>` : ''}</header>
  ${sections}
</main>
<script>
const fit = () => document.querySelectorAll('.shot iframe').forEach((f) => { f.style.transform = 'scale(' + f.parentElement.clientWidth / 1280 + ')'; });
addEventListener('resize', fit); fit();
</script>
`;
}
