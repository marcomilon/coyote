import type { Theme } from '../src/core/theme';
import { artesanal } from './artesanal';
import { cartel } from './cartel';
import { clinico } from './clinico';
import { editorial } from './editorial';
import { nocturno } from './nocturno';
import { tropical } from './tropical';

const ALL = [editorial, cartel, artesanal, nocturno, tropical, clinico];

export const THEMES: Record<string, Theme> = Object.fromEntries(ALL.map((theme) => [theme.id, theme]));
export const THEME_IDS = ALL.map((theme) => theme.id) as [string, ...string[]];
