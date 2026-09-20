/**
 * Runs the real pipeline against Bedrock and writes out/index.html + out/site.json.
 *   npm run generate:local -- --name "Panadería Luna" --about "..." --whatsapp "+57 300 123 4567" [--address ..] [--instagram ..] [--facebook ..] [--lang es|pt]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { THEMES } from '../themes';
import { normalizeAnswers } from '../src/core/answers';
import { callTool } from '../src/core/bedrock';
import { generateSite } from '../src/core/pipeline';
import { modelId as resolveModelId } from '../src/core/models';
import { checkHtml } from '../src/core/policy';
import { isRejected, prescreen } from '../src/core/prescreen';
import { render } from '../src/core/render';
import { slugify } from '../src/core/slug';
import { createUrls, urlConfigFromEnv, type UrlConfig } from '../src/core/urls';

process.env.AWS_PROFILE ??= 'coyote';

// USD per million tokens (Haiku 4.5), for a rough cost line only. Verify against current Bedrock pricing.
const HAIKU_PRICE = { input: 1, output: 5 };

const LOCAL_URLS: UrlConfig = {
  mode: 'domainless',
  appBaseUrl: 'http://localhost:5173',
  apiBaseUrl: 'http://localhost:5173',
  sitesBaseUrl: 'http://localhost:5173/_sites',
};

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    about: { type: 'string' },
    whatsapp: { type: 'string' },
    address: { type: 'string' },
    instagram: { type: 'string' },
    facebook: { type: 'string' },
    lang: { type: 'string' },
    out: { type: 'string', default: 'out' },
  },
});

if (!values.name || !values.about || !values.whatsapp) {
  console.error('Required: --name, --about, --whatsapp');
  process.exit(1);
}

const answers = normalizeAnswers({
  businessName: values.name,
  about: values.about,
  whatsapp: values.whatsapp,
  address: values.address,
  instagram: values.instagram,
  facebook: values.facebook,
  lang: values.lang,
});

const modelId = resolveModelId();
const started = Date.now();

// Same order as the deployed flow: pre-screen first, generate only if it passes.
const screening = await prescreen(answers, { callTool, modelId });
if (isRejected(screening)) {
  console.error(`REJECTED by pre-screen: ${screening.category} (${screening.confidence}) ${screening.reason.slice(0, 240)}`);
  process.exit(2);
}

const generated = await generateSite(answers, { callTool, modelId });
const { brief, content } = generated;
const usage = [screening.usage, ...generated.usage];

const urls = createUrls(process.env.SITES_BASE_URL || process.env.DOMAIN_NAME ? urlConfigFromEnv(process.env) : LOCAL_URLS);
const slug = slugify(answers.businessName);
const page = render({
  theme: THEMES[brief.theme]!,
  content,
  brief,
  siteUrl: urls.siteUrl(slug),
  reportUrl: urls.reportUrl(slug),
  privacyUrl: urls.privacyUrl,
});

const htmlViolations = checkHtml(page, { platformOrigins: [new URL(urls.appUrl).origin, urls.siteOrigin(slug)] });
if (htmlViolations.length > 0) {
  console.error('Rendered page breaks the HTML policy:', htmlViolations);
  process.exit(1);
}

const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'index.html'), page);
writeFileSync(resolve(outDir, 'site.json'), JSON.stringify({ slug, brief, content, usage }, null, 2));

const input = usage.reduce((n, u) => n + u.inputTokens, 0);
const output = usage.reduce((n, u) => n + u.outputTokens, 0);
const cost = modelId.includes('claude-haiku-4-5')
  ? ` ~$${((input * HAIKU_PRICE.input + output * HAIKU_PRICE.output) / 1_000_000).toFixed(4)},`
  : '';
console.log(`${resolve(outDir, 'index.html')}`);
console.log(`theme=${brief.theme} fonts=${brief.fontPairing} palette=${Object.values(brief.palette).join(' ')}`);
console.log(`${modelId}: ${usage.length} calls, ${input} in / ${output} out tokens,${cost} ${((Date.now() - started) / 1000).toFixed(1)} s`);
