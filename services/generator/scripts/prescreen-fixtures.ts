/**
 * Runs every prescreen fixture through the real model and compares with the hardcoded brand list.
 *   npm run prescreen:fixtures            (model from src/core/models.ts; override with BEDROCK_MODEL_ID)
 * Exits 1 if any decision differs from the expected one.
 */
import { normalizeAnswers } from '../src/core/answers';
import { callTool } from '../src/core/bedrock';
import { findBrand } from '../src/core/brands';
import { modelId as resolveModelId } from '../src/core/models';
import { isRejected, prescreen } from '../src/core/prescreen';
import { PRESCREEN_CASES, type PrescreenCase } from '../test/fixtures/prescreen-cases';

process.env.AWS_PROFILE ??= 'coyote';
const modelId = resolveModelId();
const CONCURRENCY = 4;

interface Row {
  testCase: PrescreenCase;
  got: 'allow' | 'reject' | 'error';
  category: string;
  confidence: number;
  list: string;
  tokens: number;
}

async function run(testCase: PrescreenCase): Promise<Row> {
  const list = findBrand(testCase.name, 'name') ?? '';
  try {
    const answers = normalizeAnswers({ businessName: testCase.name, about: testCase.about, whatsapp: '573001234567' });
    const result = await prescreen(answers, { callTool, modelId });
    return {
      testCase,
      got: isRejected(result) ? 'reject' : 'allow',
      category: result.category,
      confidence: result.confidence,
      list,
      tokens: result.usage.inputTokens + result.usage.outputTokens,
    };
  } catch (error) {
    return { testCase, got: 'error', category: String(error).slice(0, 60), confidence: 0, list, tokens: 0 };
  }
}

const rows: Row[] = [];
const queue = [...PRESCREEN_CASES];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) rows.push(await run(next));
  }),
);
rows.sort((a, b) => PRESCREEN_CASES.indexOf(a.testCase) - PRESCREEN_CASES.indexOf(b.testCase));

console.log(`model: ${modelId}\n`);
for (const row of rows) {
  const mark = row.got === row.testCase.expect ? '  ' : '✗ ';
  console.log(
    `${mark}${row.testCase.expect.padEnd(6)} → ${row.got.padEnd(6)} ${row.confidence.toFixed(2)} ${row.category.padEnd(28)} list:${(row.list || '-').padEnd(12)} ${row.testCase.name}`,
  );
}

const wrong = rows.filter((row) => row.got !== row.testCase.expect);
const bad = rows.filter((row) => row.testCase.expect === 'reject');
console.log(`\n${rows.length - wrong.length}/${rows.length} correct, ${rows.reduce((n, r) => n + r.tokens, 0)} tokens`);
console.log(`bad cases caught by the model: ${bad.filter((r) => r.got === 'reject').length}/${bad.length}; by the hardcoded list alone: ${bad.filter((r) => r.list).length}/${bad.length}`);
if (wrong.length > 0) {
  console.log('\nMismatches:');
  for (const row of wrong) console.log(`- ${row.testCase.name}: expected ${row.testCase.expect}, got ${row.got} (${row.category})`);
  process.exit(1);
}
