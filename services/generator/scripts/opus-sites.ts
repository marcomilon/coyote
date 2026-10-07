/**
 * Experiment: can the pipeline match what Claude makes in chat? Each test business goes to Claude Opus 5.5
 * through Anthropic's API (thinking on), with the frontend-design skill as the system prompt and a chat-like
 * request, and the page comes back as one HTML document. (A version with technical notes in the prompt made
 * worse designs and was removed.) The hero photos are the ones earlier runs generated.
 * Writes out/opus/<id>-skill/index.html, chat-prompt.txt (the same request, to paste into a chat for
 * comparison), and out/opus/skill.html with every page side by side.
 *   npm run opus:sites -w services/generator -- --only panaderia,salon-vago,ferreteria [--effort high]
 * The API key comes from ANTHROPIC_API_KEY or the AWS secret coyote/anthropic-api-key (profile coyote).
 */
import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeAnswers } from '../src/core/answers';
import { FRONTEND_DESIGN } from '../src/core/frontend-design';
import { pagePrompt, pickLook } from '../src/core/page-writer';
import { BUSINESSES } from './bakeoff-businesses';

process.env.AWS_PROFILE ??= 'coyote';

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4, output: 20 }; // USD per million tokens, Anthropic list price; thinking bills as output

const { values } = parseArgs({
  options: {
    only: { type: 'string', default: 'panaderia,salon-vago,ferreteria' },
    effort: { type: 'string', default: 'high' },
    out: { type: 'string', default: 'out/opus' },
    // The same business several times, to see how much the designs vary.
    repeat: { type: 'string', default: '1' },
    'no-look': { type: 'boolean', default: false },
  },
});

async function apiKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const { SecretString } = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: 'coyote/anthropic-api-key' }));
  if (!SecretString) throw new Error('the secret coyote/anthropic-api-key is empty');
  const value = SecretString.trim();
  if (!value.startsWith('{')) return value;
  // A key/value secret from the console: take the value that looks like an Anthropic key, whatever its field name.
  const key = Object.values(JSON.parse(value) as Record<string, unknown>).find((v) => typeof v === 'string' && v.startsWith('sk-ant-'));
  if (typeof key !== 'string') throw new Error('no Anthropic API key (sk-ant-…) in the secret coyote/anthropic-api-key');
  return key;
}

/** The same skill text the pipeline uses. */
const SKILL = FRONTEND_DESIGN;

/** The pipeline's own request (pagePrompt), with a fresh look nudge unless --no-look. No photos: Opus draws SVG. */
function skillRequest(business: (typeof BUSINESSES)[number]) {
  const answers = normalizeAnswers(business.form);
  const contact = { ...answers.contact, address: answers.contact.address ?? business.canned.address, instagram: answers.contact.instagram ?? business.canned.instagram?.replace(/^@/, '') };
  const notes = [{ question: 'More details:', answer: business.canned.details }];
  const look = values['no-look'] ? undefined : pickLook();
  const user = pagePrompt({ answers: { ...answers, contact }, notes, photos: [], look });
  return { contact, user, look };
}

/** What our checks would say about a page written freely: contact links must be the owner's, no forms, no outside links. */
function audit(html: string, whatsapp: string): string[] {
  const problems: string[] = [];
  for (const [, number] of html.matchAll(/https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d+)/g)) if (number !== whatsapp) problems.push(`WhatsApp link to ${number}`);
  if (!html.includes(`wa.me/${whatsapp}`) && !html.includes(`phone=${whatsapp}`)) problems.push('no WhatsApp link to the owner');
  if (/<form\b|<input\b/i.test(html)) problems.push('a form or input');
  if (/<iframe\b/i.test(html)) problems.push('an iframe');
  for (const [, href] of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const host = new URL(href!).host;
    if (!/(^|\.)(wa\.me|whatsapp\.com|instagram\.com|facebook\.com|google\.com|googleapis\.com|gstatic\.com|jsdelivr\.net|cloudflare\.com|unpkg\.com|tailwindcss\.com)$/.test(host)) problems.push(`link to ${host}`);
  }
  for (const [, src] of html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g)) problems.push(`outside image ${new URL(src!).host}`);
  return [...new Set(problems)];
}

const client = new Anthropic({ apiKey: await apiKey() });
const outDir = resolve(values.out!);
const ids = values.only!.split(',').map((s) => s.trim());
const rows: string[] = [];

const runs = ids.flatMap((id) => Array.from({ length: Number(values.repeat) }, (_, n) => ({ id, n })));
for (const { id, n } of runs) {
  const business = BUSINESSES.find((b) => b.id === id);
  if (!business) throw new Error(`unknown business ${id}`);
  const { contact, user, look } = skillRequest(business);
  const folder = `${id}-skill${Number(values.repeat) > 1 ? `-${n + 1}` : ''}`;
  const dir = resolve(outDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'chat-prompt.txt'), `${user}\n`);

  const started = Date.now();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: SKILL,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: values.effort },
  } as Anthropic.MessageStreamParams);
  const message = await stream.finalMessage();
  const seconds = (Date.now() - started) / 1000;
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  const html = [...text.matchAll(/```html[^\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1] ?? /<!doctype html[\s\S]*<\/html>/i.exec(text)?.[0];
  const cost = (message.usage.input_tokens * PRICE.input + message.usage.output_tokens * PRICE.output) / 1_000_000;
  if (!html) {
    console.log(`${id}: no HTML in the reply (stop: ${message.stop_reason})`);
    continue;
  }
  writeFileSync(resolve(dir, 'index.html'), html);
  const problems = audit(html, contact.whatsapp);
  console.log(`${folder} [${look ? `${look.tones.join(' / ')}, ${look.dark ? 'dark' : 'light'}` : 'no nudge'}]: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out, $${cost.toFixed(3)}, ${seconds.toFixed(0)} s, stop: ${message.stop_reason}; checks: ${problems.length ? problems.join('; ') : 'clean'}`);
  rows.push(`<tr><th>${folder}<br><small>${look ? `${look.tones.join(' / ')} · ${look.dark ? 'dark' : 'light'}<br>` : ''}$${cost.toFixed(2)} · ${seconds.toFixed(0)} s · effort ${values.effort}</small></th>
<td><p>Opus 5.5, frontend-design skill</p><div class="shot"><iframe src="${folder}/index.html"></iframe></div><a href="${folder}/index.html" target="_blank">open</a> · <a href="${folder}/chat-prompt.txt" target="_blank">chat prompt</a></td></tr>`);
}

writeFileSync(
  resolve(outDir, 'skill.html'),
  `<!doctype html><meta charset="utf-8"><title>Opus sites</title><style>body{margin:0;padding:16px;background:#1d1d1f;color:#eee;font:13px system-ui}td,th{vertical-align:top;padding:10px;text-align:left}.shot{width:512px;height:600px;overflow:hidden;background:#fff}.shot iframe{width:1280px;height:1500px;border:0;transform:scale(.4);transform-origin:0 0}a{color:#8ab4f8}</style><h1>Opus 5.5 (model-written)</h1><table>${rows.join('')}</table>`,
);
console.log(resolve(outDir, 'skill.html'));
