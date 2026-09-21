/**
 * Runs the prescreen fixture set through the DEPLOYED API (the whole stack: rate limit, brand list,
 * guardrail, classifier, generation). Bad cases must get 422 at submit; good cases must reach DONE.
 *   npm run verify:live -w services/generator      (costs about 60 model calls; rejections may trigger the Rejected alarm)
 */
import { readFileSync } from 'node:fs';
import { PRESCREEN_CASES } from '../test/fixtures/prescreen-cases';

const api = (JSON.parse(readFileSync(new URL('../../../infra/cdk-outputs.json', import.meta.url), 'utf8')).Coyote.ApiUrl as string).replace(/\/$/, '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Row { name: string; expect: string; submit: number; final: string }
const rows: Row[] = [];
const queue = [...PRESCREEN_CASES];

await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const response = await fetch(`${api}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ businessName: c.name, about: c.about, whatsapp: '+57 300 123 4567' }),
      });
      const body = (await response.json().catch(() => ({}))) as { jobId?: string };
      let final = response.status === 422 ? 'REJECTED' : `HTTP ${response.status}`;
      if (response.status === 202 && body.jobId) {
        for (let i = 0; i < 40; i++) {
          await sleep(3000);
          const job = (await (await fetch(`${api}/jobs/${body.jobId}`)).json()) as { status: string };
          if (job.status !== 'PENDING') { final = job.status; break; }
        }
      }
      rows.push({ name: c.name, expect: c.expect, submit: response.status, final });
    }
  }),
);

let wrong = 0;
for (const row of rows.sort((a, b) => a.expect.localeCompare(b.expect))) {
  const ok = row.expect === 'reject' ? row.final === 'REJECTED' : row.final === 'DONE';
  if (!ok) wrong++;
  console.log(`${ok ? '  ' : '✗ '}${row.expect.padEnd(6)} submit=${row.submit} final=${row.final.padEnd(9)} ${row.name}`);
}
console.log(`\n${rows.length - wrong}/${rows.length} as expected`);
process.exit(wrong === 0 ? 0 : 1);
