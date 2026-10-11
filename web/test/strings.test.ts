import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n/strings';

/** Every string under `value`, with its path. */
function leaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, v]) => leaves(v, path ? `${path}.${key}` : key));
  return [];
}

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe('Spanish with vos', () => {
  const tu = new Map(leaves(t('es')));
  const vos = new Map(leaves(t('es', true)));

  it('has the same shape as the tú strings', () => {
    expect([...vos.keys()].sort()).toEqual([...tu.keys()].sort());
  });

  it('keeps every placeholder', () => {
    for (const [path, text] of vos) expect(placeholders(text), path).toEqual(placeholders(tu.get(path)!));
  });

  it('leaves no tú forms', () => {
    const changed = [...vos.values()];
    // \b does not see accented letters as part of a word, so the boundaries are spelled out.
    const tuForms = /(^|[^\p{L}])(tú|tienes|puedes|quieres|haces|vendes|pides|respondes|ajustas|publicas|pagas|decides|aceptas|apagas|crees|sigues|confirmas|necesitas|eres|Crea|Créalo|Responde|Pide|Escribe|Escríbeme|Escríbenos|Cuéntanos|Cuenta|Revisa|Revísalo|Inténtalo|inténtalo|Elige|Abre|Ábrela|Entra|Vuelve|Busca|regístralo|Mira|Mírala|Llena|Espera|Escanea|Avísanos|cuéntanoslo|Empieza|Cancela|Agrega|Cambia|Toca|Usa|Sube|Copia|Intenta|Prueba|Dime)(?!\p{L})/u;
    for (const text of changed) expect(text, text).not.toMatch(tuForms);
  });

  it('changes nothing for Portuguese', () => {
    expect(t('pt', true)).toBe(t('pt'));
  });
});
