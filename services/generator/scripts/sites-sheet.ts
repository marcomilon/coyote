/**
 * The screenshot sheet for the bake-off: every generated page in out/sites/ at phone (390 px) and desktop
 * (1280 px) width, with its model, cost, time, questions, and lint problems next to it.
 *   npm run sites:sheet            then open services/generator/out/sites/index.html
 * generate:local writes it too.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Usage } from '../src/core/bedrock';
import type { Note, Question } from '../src/core/questions';

export interface SiteReport {
  id: string;
  modelId: string;
  name: string;
  dir: string;
  questions: Question[];
  notes?: Note[];
  lint: string[];
  heroScene?: string;
  seconds: number;
  cost?: number;
  usage: Usage[];
  error?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function writeSheet(outDir: string): string {
  const reports: SiteReport[] = [];
  for (const model of existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : []) {
    for (const site of readdirSync(resolve(outDir, model.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const file = resolve(outDir, model.name, site.name, 'report.json');
      if (existsSync(file)) reports.push(JSON.parse(readFileSync(file, 'utf8')) as SiteReport);
    }
  }
  const models = [...new Set(reports.map((r) => r.modelId))].sort();
  const ids = [...new Set(reports.map((r) => r.id))].sort();

  const totals = models
    .map((m) => {
      const mine = reports.filter((r) => r.modelId === m && !r.error);
      const cost = mine.reduce((n, r) => n + (r.cost ?? 0), 0);
      const seconds = mine.reduce((n, r) => n + r.seconds, 0);
      return `<li><b>${esc(m)}</b>: ${mine.length} sites, ~$${(cost / Math.max(mine.length, 1)).toFixed(3)} and ${(seconds / Math.max(mine.length, 1)).toFixed(0)} s per site</li>`;
    })
    .join('');

  const cell = (r: SiteReport | undefined) => {
    if (!r) return '<td></td>';
    const src = esc(relative(outDir, resolve(r.dir, 'index.html')));
    const meta = `<p class="meta">${esc(r.modelId)} · ${r.cost !== undefined ? `$${r.cost.toFixed(3)}` : '?'} · ${r.seconds.toFixed(0)} s</p>`;
    const questions = r.questions.length ? `<details><summary>${r.questions.length} question(s)</summary><ul>${r.questions.map((q) => `<li>${esc(q.label)} <i>(${q.type})</i></li>`).join('')}</ul></details>` : '<p class="meta">no questions</p>';
    const lint = r.lint.length ? `<ul class="lint">${r.lint.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="meta">lint: clean</p>';
    if (r.error) return `<td>${meta}<p class="error">${esc(r.error)}</p>${questions}</td>`;
    return `<td>${meta}${questions}${lint}<div class="shots"><div class="phone"><iframe src="${src}" loading="lazy"></iframe></div><div class="desk"><iframe src="${src}" loading="lazy"></iframe></div></div><p><a href="${src}" target="_blank">open</a></p></td>`;
  };

  const rows = ids.map((id) => `<tr><th>${esc(id)}<br><small>${esc(reports.find((r) => r.id === id)!.name)}</small></th>${models.map((m) => cell(reports.find((r) => r.id === id && r.modelId === m))).join('')}</tr>`).join('');

  writeFileSync(
    resolve(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Coyote sites</title>
<style>
body{margin:0;background:#1d1d1f;color:#eee;font:13px/1.4 system-ui;padding:16px}
table{border-collapse:collapse}th,td{vertical-align:top;padding:10px;border-top:1px solid #444;text-align:left}
th{width:120px}.meta{color:#aaa;margin:0 0 6px}.error{color:#ff8a80}.lint{color:#ffd180;margin:4px 0;padding-left:16px}
.shots{display:flex;gap:12px;align-items:flex-start}
.phone{width:195px;height:422px;overflow:hidden;border-radius:12px;background:#fff}.phone iframe{width:390px;height:844px;border:0;transform:scale(.5);transform-origin:0 0}
.desk{width:512px;height:320px;overflow:hidden;background:#fff}.desk iframe{width:1280px;height:800px;border:0;transform:scale(.4);transform-origin:0 0}
a{color:#8ab4f8}
</style>
<h1>Coyote sites</h1><ul>${totals}</ul><table>${rows}</table>`,
  );
  return resolve(outDir, 'index.html');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(writeSheet(resolve('out/sites')));
