import type { Theme } from '../src/core/theme';
import { plain } from './plain';

export const THEMES: Record<string, Theme> = { [plain.id]: plain };
export const THEME_IDS = Object.keys(THEMES) as [string, ...string[]];
