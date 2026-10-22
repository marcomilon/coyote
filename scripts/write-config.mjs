// Writes web/public/config.js with the deployed API URL, the landing examples' URLs, and the Turnstile site key (from infra/cdk-outputs.json),
// and Paddle's public client token (CDK context `paddle` in infra/cdk.json).
// Also an empty web/public/tags.js: no marketing tags in development.
// Runs before `astro dev`. The deployed app gets both files from the CDK BucketDeployment instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputsFile = `${root}infra/cdk-outputs.json`;

const outputs = existsSync(outputsFile) ? (JSON.parse(readFileSync(outputsFile, 'utf8')).Coyote ?? {}) : {};
const apiUrl = outputs.ApiUrl ?? null;
const examples = outputs.ExampleUrls ? JSON.parse(outputs.ExampleUrls) : {};
const turnstile = outputs.TurnstileSiteKey ? { turnstileSiteKey: outputs.TurnstileSiteKey } : {};
const paddleContext = JSON.parse(readFileSync(`${root}infra/cdk.json`, 'utf8')).context?.paddle;
const paddle = paddleContext ? { paddle: { env: paddleContext.env, clientToken: paddleContext.clientToken } } : {};
writeFileSync(`${root}web/public/config.js`, `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl, examples, ...turnstile, ...paddle })};\n`);
writeFileSync(`${root}web/public/tags.js`, '// No marketing tags in development.\n');
console.log(apiUrl ? `API → ${apiUrl}` : 'No ApiUrl in infra/cdk-outputs.json. Run "./coyote.sh deploy" first; API calls will fail.');
