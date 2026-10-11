// Writes web/public/config.js with the deployed API URL and the landing examples' URLs (from infra/cdk-outputs.json).
// Runs before `astro dev`. The deployed app gets its config.js from the CDK BucketDeployment instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputsFile = `${root}infra/cdk-outputs.json`;

const outputs = existsSync(outputsFile) ? (JSON.parse(readFileSync(outputsFile, 'utf8')).Coyote ?? {}) : {};
const apiUrl = outputs.ApiUrl ?? null;
const examples = outputs.ExampleUrls ? JSON.parse(outputs.ExampleUrls) : {};
writeFileSync(`${root}web/public/config.js`, `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl, examples })};\n`);
console.log(apiUrl ? `API → ${apiUrl}` : 'No ApiUrl in infra/cdk-outputs.json. Run "./coyote.sh deploy" first; API calls will fail.');
