/**
 * The template library in the repo (`templates/index.json` and `templates/<id>.html`), for `./coyote.sh page-templates`.
 *   list                          the templates and their descriptions
 *   add <id> <file> <description> check a template and add it (or replace the one with that id)
 *   rm <id>                       take a template out
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemplate } from '../src/core/template';
import type { TemplateInfo } from '../src/core/template-writer';

const dir = fileURLToPath(new URL('../templates/', import.meta.url));
const indexFile = `${dir}index.json`;
const read = (): TemplateInfo[] => (existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as TemplateInfo[]) : []);
const write = (index: TemplateInfo[]) => writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const [command, id, file, description] = process.argv.slice(2);
switch (command) {
  case 'list': {
    const index = read();
    if (index.length === 0) console.log('  (none: npm run templates:make -w services/generator makes some)');
    for (const t of index) console.log(`  ${t.id}  ${t.description}`);
    break;
  }
  case 'add': {
    if (!id || !/^[a-z0-9-]{1,40}$/.test(id)) fail('a template id is lowercase letters, digits and hyphens');
    if (!file || !existsSync(file)) fail(`no such file: ${file}`);
    if (!description?.trim()) fail('give the template a short description (the picker reads it)');
    const html = readFileSync(file!, 'utf8');
    const manifest = parseTemplate(html);
    if (manifest.errors.length > 0) fail(`the template can't be used:\n  ${manifest.errors.join('\n  ')}`);
    writeFileSync(`${dir}${id}.html`, html);
    write([...read().filter((t) => t.id !== id), { id: id!, description: description!.trim() }]);
    console.log(`Added ${id}: ${manifest.texts.length} texts, ${manifest.repeats.length} lists, ${manifest.images.length} photos, contacts ${manifest.contacts.join(', ')}.`);
    break;
  }
  case 'rm': {
    if (!read().some((t) => t.id === id)) fail(`no template ${id}`);
    rmSync(`${dir}${id}.html`, { force: true });
    write(read().filter((t) => t.id !== id));
    console.log(`Removed ${id}.`);
    break;
  }
  default:
    fail('usage: templates list | add <id> <file> <description> | rm <id>');
}
