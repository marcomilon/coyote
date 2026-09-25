/**
 * Runs the real site writer against Bedrock, offline (no stack needed): pre-screen → plan_site → canned
 * answers to any questions → write_site → sanitizer → fill. Writes one folder per site and model under
 * out/sites/, then the sheet (out/sites/index.html) with every page at phone and desktop width, its cost,
 * time, questions, and lint.
 *   npm run generate:local                                     the 10 bake-off businesses on the default model
 *   npm run generate:local -- --models us.anthropic.claude-opus-5-5,us.anthropic.claude-sonnet-5
 *   npm run generate:local -- --only panaderia,dentista --hero  also generate hero photos (~$0.04 each)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeAnswers } from '../src/core/answers';
import { callText, callTool, stabilityImage, type Usage } from '../src/core/bedrock';
import { renderDraft, type SiteDoc } from '../src/core/drafts';
import { HERO_FILE, HERO_NEGATIVE, heroPrompt } from '../src/core/images';
import { imageModelId, modelId as defaultModelId, prescreenModelId } from '../src/core/models';
import { isRejected, prescreen } from '../src/core/prescreen';
import { applyAnswers, CONTACT_TYPES, type Question } from '../src/core/questions';
import { sanitizePage } from '../src/core/sanitize';
import { planSite, writeSite } from '../src/core/site-writer';
import { slugify } from '../src/core/slug';
import { createUrls } from '../src/core/urls';
import { BUSINESSES, type Business } from './bakeoff-businesses';
import { writeSheet, type SiteReport } from './sites-sheet';

process.env.AWS_PROFILE ??= 'coyote';

/** USD per million tokens, list prices for the rough cost column only. Verify against Bedrock pricing. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const urls = createUrls({ mode: 'domainless', appBaseUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:5173', sitesBaseUrl: 'http://localhost:5173/_sites' });

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    only: { type: 'string' },
    hero: { type: 'boolean', default: false },
    out: { type: 'string', default: 'out/sites' },
  },
});

const models = values.models?.split(',').map((m) => m.trim()) ?? [defaultModelId()];
const only = values.only?.split(',').map((m) => m.trim());
const businesses = BUSINESSES.filter((b) => !only || only.includes(b.id));
const outDir = resolve(values.out!);

function cost(usage: Usage[]): number | undefined {
  let total = 0;
  for (const u of usage) {
    const price = Object.entries(PRICES).find(([key]) => u.modelId.includes(key))?.[1];
    if (!price) {
      if (u.step === 'classify' || u.step === 'hero_image') continue;
      return undefined;
    }
    total += ((u.inputTokens + (u.cacheWriteTokens ?? 0) * 1.25 + (u.cacheReadTokens ?? 0) * 0.1) * price.input + u.outputTokens * price.output) / 1_000_000;
  }
  return total;
}

/** How the owner would answer: the canned details for the first free-text question, the first option for picks. */
function cannedAnswers(questions: Question[], business: Business): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let detailsUsed = false;
  for (const q of questions) {
    if (q.type in CONTACT_TYPES) {
      const value = (business.canned as Record<string, string | undefined>)[CONTACT_TYPES[q.type as keyof typeof CONTACT_TYPES]];
      if (value) out[q.id] = value;
    } else if (q.type === 'choice') out[q.id] = q.options![0]!;
    else if (q.type === 'multi') out[q.id] = q.options!.slice(0, 2);
    else if (q.type === 'yesno') out[q.id] = 'yes';
    else if (!detailsUsed) {
      out[q.id] = business.canned.details;
      detailsUsed = true;
    }
  }
  return out;
}

async function run(business: Business, modelId: string): Promise<SiteReport> {
  const started = Date.now();
  const usage: Usage[] = [];
  let answers = normalizeAnswers(business.form);
  const slug = slugify(answers.businessName);
  const dir = resolve(outDir, modelId.replace(/[^a-z0-9.-]/gi, '_'), business.id);
  mkdirSync(resolve(dir, 'assets'), { recursive: true });
  const report: SiteReport = { id: business.id, modelId, name: answers.businessName, dir, questions: [], lint: [], seconds: 0, usage };

  try {
    const screening = await prescreen(answers, { callTool, modelId: prescreenModelId() });
    usage.push(screening.usage);
    if (isRejected(screening)) throw new Error(`rejected by the pre-screen: ${screening.category}`);

    const deps = { callTool, callText, modelId, outputAllowed: async () => true };
    const input = { answers, notes: [] as SiteDoc['notes'], media: { photos: [] } as SiteDoc['media'], images: [] };
    const plan = await planSite(input, deps);
    usage.push(...plan.usage);
    report.questions = plan.questions;
    if (plan.questions.length > 0) {
      const applied = applyAnswers(plan.questions, cannedAnswers(plan.questions, business));
      if (!applied.ok) throw new Error(`canned answers rejected: ${applied.fields.join(', ')}`);
      answers = { ...answers, contact: { ...answers.contact, ...applied.contact } };
      Object.assign(input, { answers, notes: applied.notes });
      report.notes = applied.notes;
    }

    const written = await writeSite(input, deps, usage);
    let media = input.media;
    const imageModel = imageModelId();
    if (values.hero && imageModel && written.heroScene && written.source.includes('{{hero}}')) {
      const bytes = await stabilityImage(imageModel)(heroPrompt(written.heroScene), HERO_NEGATIVE);
      if (bytes) {
        writeFileSync(resolve(dir, 'assets', HERO_FILE), bytes);
        media = { ...media, hero: `assets/${HERO_FILE}` };
      }
    }
    const doc: SiteDoc = { answers, notes: input.notes, media };
    writeFileSync(resolve(dir, 'source.html'), written.source);
    writeFileSync(resolve(dir, 'index.html'), renderDraft(written.source, doc, slug, urls));
    writeFileSync(resolve(dir, 'site.json'), JSON.stringify({ doc, heroScene: written.heroScene, questions: plan.questions }, null, 2));
    report.lint = sanitizePage(written.source).lint;
    report.heroScene = written.heroScene;
  } catch (error) {
    report.error = String(error).slice(0, 500);
  }
  report.seconds = (Date.now() - started) / 1000;
  report.cost = cost(usage);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  const tokens = `${usage.reduce((n, u) => n + u.inputTokens, 0)} in / ${usage.reduce((n, u) => n + u.outputTokens, 0)} out`;
  console.log(`${modelId}  ${business.id}: ${report.error ? `ERROR ${report.error}` : 'ok'}  ${report.questions.length} question(s)  ${tokens}  ${report.cost !== undefined ? `$${report.cost.toFixed(3)}` : ''}  ${report.seconds.toFixed(0)} s`);
  return report;
}

for (const modelId of models) {
  // A few at a time: each page takes a minute or two.
  for (let i = 0; i < businesses.length; i += 3) await Promise.all(businesses.slice(i, i + 3).map((b) => run(b, modelId)));
}
console.log(writeSheet(outDir));
