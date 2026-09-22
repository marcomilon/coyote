import { html } from '../src/core/html';
import { areaLine, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Bento board: every piece of information is its own tile, sized by importance; the WhatsApp tile is the loudest. */
export const mosaico: Theme = {
  id: 'mosaico',
  meta: {
    name: 'Mosaico',
    industries: ['shops and boutiques', 'barbershops', 'pet shops', 'electronics and phone repair', 'laundries', 'print and copy shops'],
    moods: ['modern', 'organized', 'lively', 'practical'],
    scheme: 'light',
    fontStyles: ['sans', 'soft', 'contrast'],
    defaultPalette: { ink: '#1c1f1a', paper: '#f1efe7', accent: '#3553c4' },
  },
  css: `
.grid{width:min(76rem,100% - 1.5rem);margin:.75rem auto;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.75rem}
.t{min-width:0;border-radius:1.4rem;padding:clamp(1.3rem,3vw,2.2rem);background:color-mix(in srgb,var(--accent) 10%,var(--paper))}
.t h2{font-size:clamp(1.25rem,2.2vw,1.6rem);margin-bottom:1rem}
.head{grid-column:span 4;grid-row:span 2;display:flex;flex-direction:column;justify-content:space-between;gap:2.5rem;min-height:clamp(22rem,44vw,32rem)}
.head.tall{grid-row:span 3}
.brand{display:flex;align-items:center;gap:.7rem;font-weight:600}.brand .mark{width:2.4rem;height:2.4rem}
.head h1{font-size:clamp(2.4rem,6.2vw,5.2rem);line-height:1;letter-spacing:-.02em}
.head p{font-size:1.15rem;max-width:30rem;margin:1.2rem 0 0}
.pic{grid-column:span 2;margin:0;padding:0;overflow:hidden}
.pic img{width:100%;height:100%;min-height:12rem;object-fit:cover}
.sig{grid-column:span 2;position:relative;overflow:hidden;background:var(--accent);color:var(--on-accent);display:flex;align-items:flex-end;min-height:10rem}
.signature{position:absolute;overflow:hidden;inset:0}
.sig p{position:relative;margin:0;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(1.3rem,2.4vw,1.9rem);line-height:1.05}
.go{grid-column:span 2;background:var(--ink);color:var(--paper);display:flex;flex-direction:column;justify-content:space-between;gap:1.5rem}
.cta{font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(1.5rem,2.6vw,2.1rem);line-height:1.1;color:inherit;text-decoration:none}
.cta::after{content:' →'}
.cta:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.2em}
.go nav{display:flex;gap:1.2rem;font-size:.95rem}
.svc{grid-column:span 4}.svc.wide{grid-column:span 6}
.svc ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:2rem}
.svc li{padding:.8rem 0;border-top:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}
.svc strong{display:block;font-size:1.1rem}
.svc span{opacity:.8;font-size:.97rem}
.hrs{grid-column:span 2;background:var(--paper);border:2px solid var(--ink)}
.hrs dl{margin:0;display:grid;gap:.9rem}
.hrs dt{font-size:.92rem;opacity:.8}
.hrs dd{margin:0;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(1.4rem,2.4vw,1.9rem);line-height:1.1}
.abt{grid-column:span 3}.abt.wide{grid-column:span 6}
.abt p{margin:0;font-size:1.12rem;line-height:1.6;max-width:38rem}
.loc{grid-column:span 3;background:var(--ink);color:var(--paper)}
.loc address{font-style:normal;font-size:1.25rem;line-height:1.5}
.more{grid-column:1/-1}
.more img{border-radius:1.4rem}
@media (max-width:52rem){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.head,.head.tall{grid-column:span 2;grid-row:auto;min-height:0}.pic,.svc,.svc.wide,.hrs,.abt,.abt.wide,.loc{grid-column:span 2}.sig,.go{grid-column:span 1}}
@media (max-width:30rem){.sig,.go{grid-column:span 2}.sig{min-height:7rem}.svc ul{grid-template-columns:1fr}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<main class="grid">
  <header class="t head${photos.length ? ' tall' : ''}">
    <span class="brand">${logo}${content.businessName}</span>
    <div><h1>${content.headline}</h1><p>${content.subhead}</p></div>
  </header>
  ${photos.length ? html`<figure class="t pic">${photos[0]}</figure>` : ''}
  <div class="t sig"><div class="signature" aria-hidden="true"></div><p>${areaLine(content) || content.businessName}</p></div>
  <div class="t go"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
    <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
  </div>
  <section class="t svc${content.hours?.length ? '' : ' wide'}"><h2>${t.services}</h2>
    <ul>${content.services.map((s) => html`<li><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</li>`)}</ul>
  </section>
  ${content.hours?.length ? html`<section class="t hrs"><h2>${t.hours}</h2><dl>${content.hours.map((h) => html`<div><dt>${h.days}</dt><dd>${h.time}</dd></div>`)}</dl></section>` : ''}
  <section class="t abt${placeLine(content) ? '' : ' wide'}"><h2>${t.about}</h2><p>${content.about}</p></section>
  ${placeLine(content) ? html`<section class="t loc"><h2>${t.visit}</h2><address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address></section>` : ''}
  ${photos.length > 1 ? html`<div class="photos more">${photos.slice(1)}</div>` : ''}
</main>`,
};
