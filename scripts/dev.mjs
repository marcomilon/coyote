// Serves web/ on http://localhost:5173 against the deployed API (see PLAN.md "Local development").
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const webDir = join(root, 'web');
const outputsFile = join(root, 'infra', 'cdk-outputs.json');
const port = Number(process.env.PORT ?? 5173);

function readApiUrl() {
  if (!existsSync(outputsFile)) return null;
  const outputs = JSON.parse(readFileSync(outputsFile, 'utf8'));
  return outputs.Coyote?.ApiUrl ?? null;
}

const apiUrl = readApiUrl();
writeFileSync(
  join(webDir, 'config.js'),
  `window.COYOTE_CONFIG = ${JSON.stringify({ apiUrl }, null, 2)};\n`,
);
if (!apiUrl) {
  console.warn('No ApiUrl in infra/cdk-outputs.json. Run "./coyote.sh deploy" first; API calls will fail.');
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  let file = normalize(join(webDir, decodeURIComponent(pathname)));
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end();
    return;
  }
  if (pathname.endsWith('/')) file = join(file, 'index.html');
  else if (!extname(file)) file += '.html';
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`web/  → http://localhost:${port}`);
  console.log(`API   → ${apiUrl ?? '(not deployed)'}`);
});
