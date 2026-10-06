import { createHash } from 'node:crypto';
import type { Theme } from '../src/core/theme';
import { artesanal } from './artesanal';
import { carta } from './carta';
import { cartel } from './cartel';
import { clinico } from './clinico';
import { editorial } from './editorial';
import { fogon } from './fogon';
import { mosaico } from './mosaico';
import { mostrador } from './mostrador';
import { nocturno } from './nocturno';
import { pizarra } from './pizarra';
import { tocador } from './tocador';
import { tropical } from './tropical';

const ALL = [mostrador, fogon, tocador, editorial, cartel, artesanal, nocturno, tropical, clinico, pizarra, carta, mosaico];

export const THEMES: Record<string, Theme> = Object.fromEntries(ALL.map((theme) => [theme.id, theme]));
export const THEME_IDS = ALL.map((theme) => theme.id) as [string, ...string[]];

/** The inline scripts themes may run, exactly as rendered. The final HTML check allows only these. */
export const THEME_SCRIPTS = ALL.flatMap((theme) => (theme.script ? [theme.script] : []));

/** CSP sources for THEME_SCRIPTS (`'sha256-…'`). The sites CSP allows nothing else. */
export const themeScriptHashes = () => THEME_SCRIPTS.map((script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
