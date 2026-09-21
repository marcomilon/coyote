import type { SiteContent } from './content';

/** Small helpers shared by the themes. Markup stays in each theme. */
export const placeLine = (content: SiteContent): string =>
  [content.contact.address, content.location.neighborhood, content.location.city].filter(Boolean).join(', ');

export const areaLine = (content: SiteContent): string =>
  [content.location.neighborhood, content.location.city].filter(Boolean).join(', ');

export const hasVisit = (content: SiteContent): boolean => placeLine(content) !== '' || (content.hours?.length ?? 0) > 0;

export const twoDigits = (n: number): string => String(n).padStart(2, '0');
