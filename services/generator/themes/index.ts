import type { Theme } from '../src/core/theme';
import { artesanal } from './artesanal';
import { carta } from './carta';
import { cartel } from './cartel';
import { clinico } from './clinico';
import { editorial } from './editorial';
import { mosaico } from './mosaico';
import { nocturno } from './nocturno';
import { pizarra } from './pizarra';
import { tropical } from './tropical';

const ALL = [editorial, cartel, artesanal, nocturno, tropical, clinico, pizarra, carta, mosaico];

export const THEMES: Record<string, Theme> = Object.fromEntries(ALL.map((theme) => [theme.id, theme]));
export const THEME_IDS = ALL.map((theme) => theme.id) as [string, ...string[]];
