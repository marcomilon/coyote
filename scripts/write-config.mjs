// Writes web/public/config.js with the deployed API URL (from infra/cdk-outputs.json).
// Runs before `astro dev`. The deployed app gets its config.js from the CDK BucketDeployment instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputsFile = `${root}infra/cdk-outputs.json`;

const apiUrl = existsSync(outputsFile) ? (JSON.parse(readFileSync(outputsFile, 'utf8')).Coyote?.ApiUrl ?? null) : null;
writeFileSync(`${root}web/public/config.js`, `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl })};\n`);
console.log(apiUrl ? `API → ${apiUrl}` : 'No ApiUrl in infra/cdk-outputs.json. Run "./coyote.sh deploy" first; API calls will fail.');
