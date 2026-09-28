import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Color blocks and big round shapes: a sun behind the headline, slanted section edges, chunky chips. */
export const tropical: Theme = {
  id: 'tropical',
  meta: {
    name: 'Tropical',
    industries: ['juice bars and ice cream', 'kids and parties', 'travel and tours', 'pet shops', 'beachwear', 'dance schools'],
    moods: ['playful', 'sunny', 'colorful', 'cheerful'],
    scheme: 'light',
    fontStyles: ['soft', 'sans', 'contrast'],
    defaultPalette: { ink: '#16302b', paper: '#fff6e0', accent: '#e2481c' },
  },
  css: `
.w{width:min(70rem,100% - 2.5rem);margin-inline:auto}
.hero{position:relative;overflow:hidden;background:color-mix(in srgb,var(--accent) 22%,var(--paper));padding:1.4rem 0 clamp(5rem,11vw,9rem);clip-path:polygon(0 0,100% 0,100% calc(100% - 4vw),0 100%)}
.signature{position:absolute;overflow:hidden;right:-8vw;top:-10vw;width:clamp(16rem,46vw,38rem);aspect-ratio:1;border-radius:50%;background:var(--accent)}
.brand{display:flex;align-items:center;gap:.7rem}.brand .mark{width:2.6rem;height:2.6rem}
.heroimg{margin:0}.heroimg img{border-radius:2rem;border:2px solid var(--ink);aspect-ratio:16/9}
.photos img{border-radius:1.6rem;border:2px solid var(--ink)}
.top{position:relative;display:flex;justify-content:space-between;gap:1rem;font-weight:600;margin-bottom:clamp(2.5rem,8vw,6rem)}
.top b{font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.3rem}
.hero h1{position:relative;font-size:clamp(2.6rem,8vw,6.2rem);line-height:1;max-width:11ch}
.hero p{position:relative;font-size:1.2rem;max-width:30rem;margin:1.5rem 0 2rem}
.cta{position:relative;display:inline-block;background:var(--ink);color:var(--paper);border-radius:1.2rem;padding:1.05rem 1.7rem;font-weight:600;font-size:1.08rem;text-decoration:none;rotate:-2deg}
.cta:hover{rotate:1deg}
section{padding:clamp(2.5rem,7vw,5rem) 0}
h2{font-size:clamp(1.9rem,5vw,3.2rem);margin-bottom:1.8rem}
.chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:1rem}
.chips li{border-radius:1.6rem;padding:1.2rem 1.5rem;max-width:24rem;background:color-mix(in srgb,var(--accent) 16%,var(--paper));border:2px solid var(--ink)}
.chips li:nth-child(3n+1){background:var(--accent);color:var(--on-accent);rotate:-1.5deg}
.chips li:nth-child(3n){rotate:1.2deg;border-style:dashed}
.chips strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.3rem;line-height:1.1;margin-bottom:.25rem}
.about{background:var(--ink);color:var(--paper);clip-path:polygon(0 4vw,100% 0,100% 100%,0 calc(100% - 4vw));padding:clamp(5rem,12vw,9rem) 0}
.about p{font-size:clamp(1.2rem,2.6vw,1.7rem);line-height:1.5;max-width:28em;margin:0}
.visit{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.visit>div{border-radius:2rem;padding:1.8rem;border:2px solid var(--ink)}
.visit>div:first-child{background:color-mix(in srgb,var(--accent) 22%,var(--paper));border-radius:2rem 2rem .5rem 2rem}
.visit address{font-style:normal;font-size:1.2rem;font-weight:600}
.visit dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:.5rem 1.2rem}
.visit dd{margin:0;font-weight:600}
.end{display:flex;flex-wrap:wrap;gap:1.5rem 2.5rem;align-items:center}
.end nav{display:flex;gap:1.4rem;font-weight:600}
@media (max-width:46rem){.visit{grid-template-columns:1fr}.signature{opacity:.85}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<header class="hero"><div class="signature" aria-hidden="true"></div><div class="w">
  <div class="top"><b class="brand">${logo}${content.businessName}</b><span>${areaLine(content)}</span></div>
  <h1>${content.headline}</h1>
  <p>${content.subhead}</p>
  <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
</div></header>
<main>
${photos.length ? html`<section><div class="w"><figure class="heroimg">${photos[0]}</figure></div></section>` : ''}
<section><div class="w"><h2>${t.services}</h2>
  <ul class="chips">${content.services.map((s) => html`<li><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</li>`)}</ul>
</div></section>
<section class="about"><div class="w"><h2>${t.about}</h2><p>${content.about}</p></div></section>
${photos.length > 1 ? html`<section><div class="w"><div class="photos">${photos.slice(1)}</div></div></section>` : ''}
${hasVisit(content) ? html`<section><div class="w"><h2>${t.visit}</h2><div class="visit">
  <div><address>${placeLine(content)}</address>${links.maps ? html`<p><a href="${links.maps}">${t.map}</a></p>` : ''}</div>
  ${content.hours?.length ? html`<div><dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl></div>` : ''}
</div></div></section>` : ''}
<section><div class="w end"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</div></section>
</main>`,
};
