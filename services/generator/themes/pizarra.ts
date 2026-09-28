import { html } from '../src/core/html';
import { areaLine, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Menu board: the name as a shop sign, and the services on a dark framed board that is the hero, with the hours at its foot. */
export const pizarra: Theme = {
  id: 'pizarra',
  meta: {
    name: 'Pizarra',
    industries: ['taquerías and food stands', 'cafés', 'bars', 'food trucks', 'ice cream shops', 'market stalls'],
    moods: ['casual', 'appetizing', 'neighborhood', 'straightforward'],
    scheme: 'light',
    fontStyles: ['poster', 'contrast'],
    defaultPalette: { ink: '#1e2b25', paper: '#f5efe1', accent: '#b4441f' },
  },
  css: `
.w{width:min(72rem,100% - 2rem);margin-inline:auto}
.sign{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem 1.5rem;padding:clamp(1.5rem,4vw,2.5rem) 0 1rem}
.sign .brand{display:flex;align-items:center;gap:.9rem;min-width:0;overflow-wrap:anywhere;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(2rem,7vw,4.6rem);line-height:1;text-transform:uppercase}
.sign .brand .mark{width:clamp(2.6rem,6vw,4rem);height:clamp(2.6rem,6vw,4rem)}
.sign small{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase}
.intro{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:1rem 3rem;align-items:end;border-top:3px solid var(--ink);padding:1.2rem 0 clamp(1.5rem,4vw,2.5rem)}
.intro h1{font-size:clamp(1.7rem,4vw,2.8rem);line-height:1.08}
.intro p{margin:0 0 1.1rem;font-size:1.1rem}
.cta{display:inline-block;background:var(--accent);color:var(--on-accent);font-weight:600;font-size:1.05rem;padding:.95rem 1.5rem;border-radius:.3rem;text-decoration:none;text-wrap:balance}
.cta:hover{background:var(--ink);color:var(--paper)}
.board{position:relative;background:var(--ink);color:var(--paper);border-radius:.5rem;padding:clamp(2rem,5vw,3.5rem);box-shadow:inset 0 0 0 .55rem color-mix(in srgb,var(--accent) 55%,var(--ink)),inset 0 0 0 .75rem var(--ink)}
.board h2{font-size:clamp(1.8rem,5vw,3.2rem);text-transform:uppercase;line-height:1;margin-bottom:1.4rem;padding-right:5.5rem}
.signature{position:absolute;overflow:hidden;top:clamp(1.6rem,4vw,2.8rem);right:clamp(1.6rem,4vw,2.8rem);width:4.5rem;height:4.5rem;border:2px dashed color-mix(in srgb,var(--paper) 45%,transparent);border-radius:50%}
.items{list-style:none;margin:0;padding:0;columns:2 18rem;column-gap:3rem}
.items li{break-inside:avoid;padding:.9rem 0;border-bottom:2px dashed color-mix(in srgb,var(--paper) 25%,transparent)}
.items strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(1.3rem,2.6vw,1.75rem);line-height:1.1}
.items span{opacity:.8}
.board dl{display:flex;flex-wrap:wrap;gap:.4rem 2.5rem;margin:2rem 0 0;padding-top:1.2rem;border-top:2px solid color-mix(in srgb,var(--paper) 40%,transparent)}
.board dl div{display:flex;flex-wrap:wrap;gap:0 .6rem}
.board dt{opacity:.8}.board dd{margin:0;font-weight:600;white-space:nowrap}
.heroimg{margin:.8rem 0 0}.heroimg img{border-radius:.5rem;aspect-ratio:21/9}
.photos{margin-top:.8rem}.photos img{border-radius:.5rem}
section{padding:clamp(2.5rem,6vw,4rem) 0}
h2{font-size:clamp(1.5rem,3.4vw,2.2rem);text-transform:uppercase}
.note p{margin:1rem 0 0;font-size:clamp(1.15rem,2vw,1.35rem);line-height:1.55;max-width:38rem}
.place{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:1.5rem;border-top:3px solid var(--ink)}
.place address{font-style:normal;font-size:1.2rem}
.place nav{display:flex;gap:1.4rem;font-weight:600}
@media (max-width:44rem){.intro{grid-template-columns:1fr}.board h2{padding-right:4rem}.signature{width:3.2rem;height:3.2rem}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<header class="w sign"><span class="brand">${logo}${content.businessName}</span>${areaLine(content) ? html`<small>${areaLine(content)}</small>` : ''}</header>
<main class="w">
<div class="intro"><h1>${content.headline}</h1><div><p>${content.subhead}</p><a class="cta" href="${links.whatsapp}">${content.ctaText}</a></div></div>
<div class="board">
  <div class="signature" aria-hidden="true"></div>
  <h2>${t.services}</h2>
  <ul class="items">${content.services.map((s) => html`<li><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</li>`)}</ul>
  ${content.hours?.length ? html`<dl>${content.hours.map((h) => html`<div><dt>${h.days}</dt><dd>${h.time}</dd></div>`)}</dl>` : ''}
</div>
${photos.length ? html`<figure class="heroimg">${photos[0]}</figure>` : ''}
${photos.length > 1 ? html`<div class="photos">${photos.slice(1)}</div>` : ''}
<section class="note"><h2>${t.about}</h2><p>${content.about}</p></section>
<section class="place">
  ${placeLine(content) ? html`<address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>` : ''}
  <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</section>
</main>`,
};
