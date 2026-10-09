/**
 * Design comparison: the same businesses written by the page writer under different settings (skill × look
 * nudge), side by side. It uses production's request (pagePrompt), API call (anthropicWritePage) and page checks
 * (checkPage), and never touches the stack: no sites, no emails, no rate limit.
 *   npm run opus:sites -w services/generator -- --only colombia-arepas --skills none,frontend-design,hallmark --look on,off
 *     [--images on,off] [--goal off,on] [--repeat 2] [--model opus|haiku] [--effort high] [--concurrency 6] [--out out/design/<name>]
 * Businesses: examples/<id>.json at the repo root, or an id from bakeoff-businesses.ts.
 * Skills: none, frontend-design (bundled), a path to a SKILL.md, or a name: the stack's skills bucket
 * (infra/cdk-outputs.json), else ~/.claude/skills/<name>/SKILL.md.
 * Writes <out>/index.html (the gallery; publishable as an artifact with pages/ next to it) and results.json.
 * --images on: the page writer may make photos (make_image: Stability on Bedrock us-west-2, Rekognition; the guardrail
 * only when GUARDRAIL_ID/GUARDRAIL_VERSION are set); such a page is pages/<biz>/<slug>/index.html with its assets/.
 * --tones all|<tone>,<tone>: instead of the random look, one page per tone, each offered alone (light, no ticker).
 * --goal on: the request says the business's goal (`goal` in examples/<id>.json: whatsapp, call, visit, book).
 * Every page of a business in one run (same repeat number) gets the same look nudge, so only the axes differ.
 * --out an earlier run adds to it: its other results stay in the gallery (same businesses).
 * Real API calls: about $0.50 a page on Opus. The key is ANTHROPIC_API_KEY or the secret (profile coyote).
 */
import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeAnswers, PAGE_GOALS, type Answers, type PageGoal } from '../src/core/answers';
import { outputAllowed, stabilityImage } from '../src/core/bedrock';
import { ownerText } from '../src/core/drafts';
import { imageMaker } from '../src/core/images';
import { IMAGE_PRICE, imageModelId, usageCost } from '../src/core/models';
import { checkPage } from '../src/core/page-check';
import { anthropicWritePage, DEFAULT_PAGE_SKILL, NO_SKILL, pageModel, pagePrompt, parsePage, pickLook, skillText, TONES, type Look, type PageEffort, type PageSkill } from '../src/core/page-writer';
import type { Note } from '../src/core/questions';
import { BUSINESSES } from './bakeoff-businesses';

process.env.AWS_PROFILE ??= 'coyote';

const repo = new URL('../../../', import.meta.url).pathname;
const { values } = parseArgs({
  options: {
    only: { type: 'string', default: 'colombia-arepas' },
    skills: { type: 'string', default: 'frontend-design' },
    look: { type: 'string', default: 'on' },
    images: { type: 'string', default: 'off' },
    goal: { type: 'string', default: 'off' },
    tones: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    model: { type: 'string', default: 'opus' },
    effort: { type: 'string', default: 'high' },
    concurrency: { type: 'string', default: '6' },
    out: { type: 'string' },
  },
});


interface Business {
  id: string;
  answers: Answers;
  notes: Note[];
  goal?: PageGoal;
}

function business(id: string): Business {
  const file = resolve(repo, 'examples', `${id}.json`);
  if (existsSync(file)) {
    const { form, details, goal } = JSON.parse(readFileSync(file, 'utf8')) as { form: Parameters<typeof normalizeAnswers>[0]; details?: string; goal?: PageGoal };
    if (goal && !PAGE_GOALS.includes(goal)) throw new Error(`examples/${id}.json: goal must be one of ${PAGE_GOALS.join(', ')}`);
    return { id, answers: normalizeAnswers(form), notes: details ? [{ question: 'More details:', answer: details }] : [], ...(goal && { goal }) };
  }
  const known = BUSINESSES.find((b) => b.id === id);
  if (!known) throw new Error(`unknown business ${id}: no examples/${id}.json and not in bakeoff-businesses.ts`);
  const answers = normalizeAnswers(known.form);
  const contact = { ...answers.contact, address: answers.contact.address ?? known.canned.address, instagram: answers.contact.instagram ?? known.canned.instagram?.replace(/^@/, '') };
  return { id, answers: { ...answers, contact }, notes: [{ question: 'More details:', answer: known.canned.details }] };
}

async function skill(spec: string): Promise<PageSkill | null> {
  if (spec === NO_SKILL) return null;
  if (spec === DEFAULT_PAGE_SKILL.name) return DEFAULT_PAGE_SKILL;
  if (existsSync(spec)) {
    const name = basename(spec) === 'SKILL.md' ? basename(dirname(resolve(spec))) : basename(spec, '.md');
    return { name, text: skillText(readFileSync(spec, 'utf8')) };
  }
  const outputs = resolve(repo, 'infra/cdk-outputs.json');
  const bucket = existsSync(outputs) ? (JSON.parse(readFileSync(outputs, 'utf8')).Coyote?.PageSkillsBucketName as string | undefined) : undefined;
  if (bucket) {
    try {
      const { Body } = await new S3Client({ region: 'us-east-1' }).send(new GetObjectCommand({ Bucket: bucket, Key: `${spec}.md` }));
      return { name: spec, text: skillText((await Body!.transformToString()) ?? '') };
    } catch {
      // not in the bucket: try the local skills
    }
  }
  const local = resolve(homedir(), '.claude/skills', spec, 'SKILL.md');
  if (existsSync(local)) return { name: spec, text: skillText(readFileSync(local, 'utf8')) };
  throw new Error(`no skill ${spec}: not a file, not in the skills bucket, not in ~/.claude/skills`);
}

interface Result {
  business: string;
  businessName: string;
  skill: string;
  look: boolean;
  /** Missing in runs from before the images axis: off. */
  images?: boolean;
  made?: number;
  /** The goal the request named, if any. */
  goal?: PageGoal;
  n: number;
  model: string;
  effort: string;
  tones?: Look;
  page?: string;
  prompt: string;
  seconds: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  stopReason?: string | null;
  violations: string[];
  repairs: string[];
  error?: string;
}

const model = pageModel({}, values.model);
const effort = values.effort as PageEffort;
const businesses = values.only!.split(',').map((s) => business(s.trim()));
const skills = await Promise.all(values.skills!.split(',').map((s) => skill(s.trim())));
const looks = values.look!.split(',').map((s) => s.trim() === 'on');
const imageSettings = values.images!.split(',').map((s) => s.trim() === 'on');
const goalSettings = values.goal!.split(',').map((s) => s.trim() === 'on');
const fixedTones = values.tones === 'all' ? [...TONES] : values.tones?.split(',').map((s) => s.trim());
for (const tone of fixedTones ?? []) if (!(TONES as readonly string[]).includes(tone)) throw new Error(`unknown tone ${tone}: one of ${TONES.join(', ')}`);
const repeat = Number(values.repeat);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const outDir = values.out ? resolve(values.out) : resolve(repo, `out/design/${stamp}`);
const writePage = anthropicWritePage(process.env);
const generateImage = stabilityImage(imageModelId());
const rekognition = new RekognitionClient({ region: 'us-east-1' });
/** The generate Lambda's refused moderation categories (handlers/generate.ts). */
const REFUSED = new Set(['Explicit', 'Non-Explicit Nudity of Intimate parts and Kissing', 'Violence', 'Visually Disturbing', 'Hate Symbols', 'Drugs & Tobacco', 'Gambling']);
async function moderate(file: string): Promise<string[]> {
  const { ModerationLabels } = await rekognition.send(new DetectModerationLabelsCommand({ Image: { Bytes: readFileSync(file) }, MinConfidence: 70 }));
  return [...new Set((ModerationLabels ?? []).map((label) => label.ParentName || label.Name || '').filter((name) => REFUSED.has(name)))];
}
/** make_image for one page, saving into its folder. */
const localMaker = (dir: string, made: string[]) =>
  imageMaker(
    `${dir}/`,
    {
      stores: {
        putAsset: async (file, bytes) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, bytes)),
        deletePrefix: async (file) => rmSync(file, { force: true }),
      },
      generateImage,
      moderate,
      outputAllowed: (text) => outputAllowed(text),
    },
    made,
  );

const jobs = businesses.flatMap((b) =>
  skills.flatMap((s) =>
    looks.flatMap((look) =>
      imageSettings.flatMap((images) =>
        goalSettings.flatMap((goal) =>
          (look && fixedTones ? fixedTones : [undefined]).flatMap((tone) => Array.from({ length: repeat }, (_, i) => ({ b, s, look, images, goal: goal && b.goal ? b.goal : undefined, tone, n: i + 1 }))),
        ),
      ),
    ),
  ),
).filter((job, i, all) => all.findIndex((j) => j.b === job.b && j.s === job.s && j.look === job.look && j.images === job.images && j.goal === job.goal && j.tone === job.tone && j.n === job.n) === i); // a business with no goal: one page, not two
/** One look nudge per business and repeat number, shared by its pages. */
const drawn = new Map<string, Look>();
const lookFor = (b: Business, n: number) => drawn.get(`${b.id}/${n}`) ?? drawn.set(`${b.id}/${n}`, pickLook()).get(`${b.id}/${n}`)!;
console.log(`${jobs.length} pages with ${model} (effort ${effort}) → ${outDir}`);

async function run({ b, s, look, images, goal, tone, n }: (typeof jobs)[number]): Promise<Result> {
  const skillName = s?.name ?? NO_SKILL;
  const slug = `${skillName}-look-${tone ? tone.replace(/[^a-z]+/gi, '-').toLowerCase() : look ? 'on' : 'off'}${images ? '-images' : ''}${goal ? `-goal-${goal}` : ''}-${n}`;
  const lookNudge = tone ? { tones: [tone], dark: false, noTicker: true } : lookFor(b, n);
  const request = { answers: b.answers, notes: b.notes, photos: [], ...(goal && { goal }), ...(look && { look: lookNudge }) };
  const base: Result = { business: b.id, businessName: b.answers.businessName, skill: skillName, look, images, ...(goal && { goal }), n, model, effort, tones: request.look, prompt: `pages/${b.id}/${slug}.txt`, seconds: 0, violations: [], repairs: [] };
  mkdirSync(resolve(outDir, 'pages', b.id), { recursive: true });
  writeFileSync(resolve(outDir, base.prompt), `${pagePrompt(request, s?.name ?? null, images)}\n`);
  const made: string[] = [];
  const started = Date.now();
  try {
    const reply = await writePage(request, { effort, model, skill: s, ...(images && { makeImage: localMaker(resolve(outDir, 'pages', b.id, slug), made) }) });
    Object.assign(base, {
      seconds: (Date.now() - started) / 1000,
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
      made: made.length,
      cost: (usageCost(reply.usage) ?? 0) + made.length * IMAGE_PRICE, // thinking bills as output
      stopReason: reply.stopReason,
    });
    const page = parsePage(reply.text);
    if (!page) return { ...base, error: `no HTML page in the reply (stop: ${reply.stopReason})` };
    const checked = checkPage(page, {
      contact: b.answers.contact,
      ownerText: ownerText({ answers: b.answers, notes: b.notes }),
      businessName: b.answers.businessName,
      lang: b.answers.lang,
      homeUrl: 'https://app.example/',
      reportUrl: 'https://app.example/reportar',
      privacyUrl: 'https://app.example/privacidad',
    });
    const file = images ? `pages/${b.id}/${slug}/index.html` : `pages/${b.id}/${slug}.html`;
    writeFileSync(resolve(outDir, file), checked.html);
    return { ...base, page: file, violations: checked.violations.map((v) => `${v.code}: ${v.detail}`), repairs: checked.repairs };
  } catch (error) {
    return { ...base, seconds: (Date.now() - started) / 1000, error: String(error).slice(0, 300) };
  }
}

/** Runs the jobs `limit` at a time, logging each as it finishes. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, log: (r: R) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
        log(results[i]!);
      }
    }),
  );
  return results;
}

const results = await pool(jobs, Number(values.concurrency), run, (r) =>
  console.log(`${r.business} · ${r.skill} · look ${r.look ? 'on' : 'off'}${r.images ? ` · ${r.made} photos` : ''}${r.goal ? ` · goal ${r.goal}` : ''}${r.tones?.tones.length === 1 ? ` · ${r.tones.tones[0]}` : ''} #${r.n}: ${r.error ?? `${r.violations.length ? `REJECTED (${r.violations.join('; ')})` : 'passes'}, $${r.cost!.toFixed(2)}, ${Math.round(r.seconds)} s`}`),
);
const key = (r: Result) => `${r.business}/${r.skill}/${r.look}/${!!r.images}/${r.goal ?? ''}/${r.tones?.tones.length === 1 ? r.tones.tones[0] : ''}/${r.n}`;
const earlier: Result[] = existsSync(resolve(outDir, 'results.json')) ? JSON.parse(readFileSync(resolve(outDir, 'results.json'), 'utf8')) : [];
const fresh = new Set(results.map(key));
const all = [...earlier.filter((r) => !fresh.has(key(r))), ...results];
writeFileSync(resolve(outDir, 'results.json'), `${JSON.stringify(all, null, 2)}\n`);
writeFileSync(resolve(outDir, 'index.html'), gallery(all));
const total = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
console.log(`$${total.toFixed(2)} in all. ${resolve(outDir, 'index.html')}`);

// ---------------------------------------------------------------------------------------------------------------
// The gallery: one section per business, one card per page. Written to the artifact page contract (no doctype:
// the publisher adds the skeleton), so the folder can be published as it is.

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function duration(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

function card(r: Result): string {
  const status = r.error ? `<span class="pill bad">Failed</span>` : r.violations.length ? `<span class="pill bad">Rejected</span>` : `<span class="pill ok">Passes checks</span>`;
  const tones = r.tones ? `${r.tones.tones.join(' / ')} · ${r.tones.dark ? 'dark' : 'light'}${r.tones.noTicker ? ' · no ticker' : ''}` : 'no look nudge';
  const shot = r.page
    ? `<div class="shot"><iframe src="${r.page}" loading="lazy" tabindex="-1" title="${esc(`${r.skill}, look ${r.look ? 'on' : 'off'}`)}"></iframe></div>`
    : `<div class="shot empty"><p>${esc(r.error ?? 'No page')}</p></div>`;
  const notes = [...r.violations.map((v) => `<li class="bad">${esc(v)}</li>`), ...(r.repairs.length ? [`<li>${r.repairs.length} repair${r.repairs.length > 1 ? 's' : ''}: ${esc(r.repairs.slice(0, 4).join(', '))}${r.repairs.length > 4 ? '…' : ''}</li>`] : [])].join('');
  return `<article class="card" data-skill="${esc(r.skill)}" data-look="${r.look ? 'on' : 'off'}" data-images="${r.images ? 'on' : 'off'}" data-goal="${r.goal ? 'on' : 'off'}">
  <header><h3>${esc(r.skill === NO_SKILL ? 'No skill' : r.skill)}<span class="look">look ${r.look ? 'on' : 'off'}</span>${r.images ? `<span class="look">${r.made ?? 0} photos</span>` : ''}${r.goal ? `<span class="look">goal: ${r.goal}</span>` : ''}${r.tones?.tones.length === 1 ? `<span class="look">${esc(r.tones.tones[0]!)}</span>` : ''}${repeat > 1 ? `<span class="n">#${r.n}</span>` : ''}</h3>${status}</header>
  ${shot}
  <p class="tones">${esc(tones)}</p>
  <dl class="stats">
    <div><dt>Cost</dt><dd>${r.cost === undefined ? '—' : `$${r.cost.toFixed(2)}`}</dd></div>
    <div><dt>Time</dt><dd>${duration(r.seconds)}</dd></div>
    <div><dt>In</dt><dd>${r.inputTokens?.toLocaleString('en-US') ?? '—'}</dd></div>
    <div><dt>Out</dt><dd>${r.outputTokens?.toLocaleString('en-US') ?? '—'}</dd></div>
  </dl>
  ${notes ? `<ul class="notes">${notes}</ul>` : ''}
  <p class="links">${r.page ? `<a href="${r.page}" target="_blank" rel="noopener">Open page</a>` : ''}<a href="${r.prompt}" target="_blank" rel="noopener">Request sent</a></p>
</article>`;
}

function gallery(all: Result[]): string {
  const skillNames = [...new Set(all.map((r) => r.skill))];
  const lookValues = [...new Set(all.map((r) => (r.look ? 'on' : 'off')))];
  const imageValues = [...new Set(all.map((r) => (r.images ? 'on' : 'off')))];
  const goalValues = [...new Set(all.map((r) => (r.goal ? 'on' : 'off')))];
  const total = all.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const passed = all.filter((r) => !r.error && !r.violations.length).length;
  const sections = businesses
    .map((b) => {
      const rows = all.filter((r) => r.business === b.id);
      return `<section><h2>${esc(b.answers.businessName)}<span>${esc(b.id)}</span></h2><p class="about">${esc(b.answers.about)}</p><div class="grid">${rows.map(card).join('')}</div></section>`;
    })
    .join('');
  const chips = (name: string, list: string[], label: (v: string) => string) =>
    list.length > 1 ? `<fieldset><legend>${name}</legend>${list.map((v) => `<label><input type="checkbox" id="f-${name}-${esc(v)}" data-filter="${name}" value="${esc(v)}" checked>${esc(label(v))}</label>`).join('')}</fieldset>` : '';
  return `<title>Page Writer Bench ${stamp}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a lab bench sheet. Run facts on top, then one section per business with a card per page; the thumbnail is the point. */
:root {
  --bg: #f3f4f1; --surface: #ffffff; --fg: #1b1d1a; --muted: #62675f; --line: #d9dcd4;
  --accent: #2b50c8; --ok: #1f7a4a; --ok-bg: #e2f2e8; --bad: #b3261e; --bad-bg: #fbe6e4;
  --display: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  --body: "IBM Plex Sans", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #131512; --surface: #1c1f1b; --fg: #e8eae4; --muted: #9aa094; --line: #30342e;
  --accent: #8ea6ff; --ok: #7fd6a3; --ok-bg: #173323; --bad: #ff9a8f; --bad-bg: #3a1b18; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #131512; --surface: #1c1f1b; --fg: #e8eae4; --muted: #9aa094; --line: #30342e;
  --accent: #8ea6ff; --ok: #7fd6a3; --ok-bg: #173323; --bad: #ff9a8f; --bad-bg: #3a1b18; color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 var(--body); margin: 0 }
main { max-width: 1440px; margin: 0 auto; padding-inline: 16px; padding-block: 32px 64px; display: grid; gap: 40px }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0 }
h1 { font-size: clamp(28px, 4vw, 40px); font-weight: 700; letter-spacing: -0.01em }
.run { display: grid; gap: 16px }
.facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; font-family: var(--mono); font-size: 13px; color: var(--muted) }
.facts b { color: var(--fg); font-weight: 500 }
.filters { display: flex; flex-wrap: wrap; gap: 16px }
fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
legend { float: left; margin-right: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted) }
fieldset label { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; cursor: pointer; background: var(--surface); font-size: 14px }
fieldset label:has(input:checked) { border-color: var(--accent); color: var(--accent) }
fieldset input { accent-color: var(--accent); margin: 0 }
section { display: grid; gap: 12px }
h2 { font-size: 24px; font-weight: 700; display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px }
h2 span { font: 400 13px var(--mono); color: var(--muted) }
.about { margin: 0; max-width: 75ch; color: var(--muted); font-size: 14px }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 20px; margin-top: 8px }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px; display: grid; gap: 10px; align-content: start; min-width: 0 }
.card header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap }
h3 { font-size: 18px; font-weight: 500; display: flex; gap: 8px; align-items: baseline }
h3 .look, h3 .n { font: 400 12px var(--mono); color: var(--muted) }
.pill { font-size: 12px; font-weight: 500; padding: 2px 10px; border-radius: 999px }
.pill.ok { color: var(--ok); background: var(--ok-bg) }
.pill.bad { color: var(--bad); background: var(--bad-bg) }
.shot { position: relative; aspect-ratio: 4 / 5; max-width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: #fff }
.shot iframe { position: absolute; top: 0; left: 0; width: 1280px; height: 1600px; border: 0; transform-origin: 0 0; pointer-events: none }
.shot.empty { display: grid; place-items: center; background: var(--bad-bg); color: var(--bad); padding: 16px; font-size: 13px }
.tones { margin: 0; font-size: 13px; color: var(--muted) }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 0; font-variant-numeric: tabular-nums }
.stats dt { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted) }
.stats dd { margin: 0; font-family: var(--mono); font-size: 13px }
.notes { margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); overflow-wrap: anywhere }
.notes .bad { color: var(--bad) }
.links { margin: 0; display: flex; gap: 16px; font-size: 14px }
a { color: var(--accent) }
a:focus-visible, label:focus-within { outline: 2px solid var(--accent); outline-offset: 2px }
</style>
<main>
  <header class="run">
    <h1>Page writer bench</h1>
    <p class="facts"><span>Run <b>${stamp}</b></span><span>Model <b>${esc(model)}</b></span><span>Effort <b>${esc(effort)}</b></span><span>Pages <b>${all.length}</b></span><span>Pass checks <b>${passed}/${all.length}</b></span><span>Cost <b>$${total.toFixed(2)}</b></span></p>
    <div class="filters">${chips('skill', skillNames, (v) => (v === NO_SKILL ? 'No skill' : v))}${chips('look', lookValues, (v) => `look ${v}`)}${imageValues.length > 1 ? chips('images', imageValues, (v) => `photos ${v}`) : ''}${goalValues.length > 1 ? chips('goal', goalValues, (v) => `goal ${v}`) : ''}</div>
  </header>
  ${sections}
</main>
<script>
const fit = () => document.querySelectorAll('.shot iframe').forEach((f) => { f.style.transform = 'scale(' + f.parentElement.clientWidth / 1280 + ')'; });
addEventListener('resize', fit); fit();
const apply = () => {
  const on = {};
  document.querySelectorAll('[data-filter]').forEach((i) => { (on[i.dataset.filter] ??= new Set()); if (i.checked) on[i.dataset.filter].add(i.value); });
  document.querySelectorAll('.card').forEach((c) => { c.hidden = Object.entries(on).some(([k, set]) => !set.has(c.dataset[k])); });
};
document.querySelectorAll('[data-filter]').forEach((i) => i.addEventListener('change', apply));
</script>
`;
}
