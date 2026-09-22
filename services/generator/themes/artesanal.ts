import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

const WAVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='12' viewBox='0 0 48 12'%3E%3Cpath d='M0 6c6 0 6-5 12-5s6 5 12 5 6-5 12-5 6 5 12 5' fill='none' stroke='%23000' stroke-width='2.5'/%3E%3C/svg%3E")`;

/** Warm and handmade: a label-like name tag, wavy rules, a menu with dotted leaders, rounded panels. */
export const artesanal: Theme = {
  id: 'artesanal',
  meta: {
    name: 'Artesanal',
    industries: ['bakeries', 'florists', 'crafts', 'family restaurants', 'ceramics', 'natural cosmetics'],
    moods: ['warm', 'handmade', 'friendly', 'homey'],
    scheme: 'light',
    fontStyles: ['serif', 'soft'],
    defaultPalette: { ink: '#3a2a20', paper: '#fbf3e4', accent: '#b8562e' },
  },
  css: `
.w{width:min(66rem,100% - 2.5rem);margin-inline:auto}
.wave{height:12px;background:var(--accent);-webkit-mask:${WAVE} repeat-x center/48px 12px;mask:${WAVE} repeat-x center/48px 12px}
.hero{padding:clamp(2.5rem,7vw,5rem) 0 clamp(3rem,7vw,5rem);display:grid;grid-template-columns:auto 1fr;gap:2rem clamp(2rem,6vw,5rem);align-items:start}
.tag{position:relative;border:2px solid var(--ink);border-radius:1.2rem;padding:1.3rem 1.2rem;text-align:center;max-width:12rem;rotate:-3deg;background:color-mix(in srgb,var(--accent) 14%,var(--paper))}
.tag .mark{margin:0 auto .7rem;width:3.4rem;height:3.4rem}
.heroimg{margin:0 0 1rem}.heroimg img{border-radius:2rem 2rem 2rem .4rem;aspect-ratio:16/9}
.photos img{border-radius:1.4rem}
.tag b{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.5rem;line-height:1.05}
.tag span{display:block;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;margin-top:.6rem}
.signature{position:absolute;overflow:hidden;top:-1rem;right:-1rem;width:2.4rem;height:2.4rem;border-radius:50%;background:var(--accent);border:2px solid var(--ink)}
.hero h1{font-size:clamp(2.4rem,6.4vw,4.8rem);line-height:1.04}
.hero p{font-size:1.18rem;max-width:34rem;margin:1.4rem 0 2rem}
.cta{display:inline-block;background:var(--accent);color:var(--on-accent);border-radius:999px;padding:1rem 1.8rem;font-weight:600;font-size:1.05rem;text-decoration:none;box-shadow:0 .35rem 0 color-mix(in srgb,var(--accent) 55%,var(--ink))}
section{padding:clamp(2.5rem,6vw,4.5rem) 0}
h2{font-size:clamp(1.7rem,4vw,2.6rem);margin-bottom:1.8rem}
.menu{list-style:none;margin:0;padding:0;max-width:46rem}
.menu li{padding:.95rem 0}
.menu .row{display:flex;align-items:baseline;gap:.7rem}
.menu strong{font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.35rem}
.menu .dots{flex:1;border-bottom:2px dotted color-mix(in srgb,var(--ink) 45%,transparent);translate:0 -.3rem}
.menu small{display:block;font-size:1rem;opacity:.85;max-width:34rem}
.panel{background:color-mix(in srgb,var(--accent) 13%,var(--paper));border-radius:2rem 2rem 2rem .4rem;padding:clamp(1.8rem,5vw,3.2rem);margin-left:clamp(0rem,8vw,7rem)}
.panel p{margin:0;font-size:1.2rem;line-height:1.6}
.visit{display:grid;grid-template-columns:1.4fr 1fr;gap:1.5rem}
.visit>div{border:2px solid var(--ink);border-radius:1.4rem;padding:1.5rem}
.visit>div:last-child{border-style:dashed;translate:0 1.5rem}
.visit address{font-style:normal;font-size:1.15rem}
.visit dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:.45rem 1.2rem}
.visit dd{margin:0;font-weight:600}
.end{text-align:left;display:flex;flex-wrap:wrap;gap:1.2rem 2.5rem;align-items:center}
.end nav{display:flex;gap:1.4rem}
@media (max-width:46rem){.hero{grid-template-columns:1fr}.tag{rotate:-2deg}.panel{margin-left:0}.visit{grid-template-columns:1fr}.visit>div:last-child{translate:none}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<div class="wave" aria-hidden="true"></div>
<header class="w hero">
  <div class="tag"><div class="signature" aria-hidden="true"></div>${logo}<b>${content.businessName}</b><span>${areaLine(content)}</span></div>
  <div><h1>${content.headline}</h1><p>${content.subhead}</p><a class="cta" href="${links.whatsapp}">${content.ctaText}</a></div>
</header>
<div class="wave" aria-hidden="true"></div>
<main class="w">
${photos.length ? html`<section><figure class="heroimg">${photos[0]}</figure></section>` : ''}
<section><h2>${t.services}</h2>
  <ul class="menu">${content.services.map((s) => html`<li><div class="row"><strong>${s.name}</strong><span class="dots"></span></div>${s.detail ? html`<small>${s.detail}</small>` : ''}</li>`)}</ul>
</section>
<section><div class="panel"><h2>${t.about}</h2><p>${content.about}</p></div></section>
${photos.length > 1 ? html`<section><div class="photos">${photos.slice(1)}</div></section>` : ''}
${hasVisit(content) ? html`<section><h2>${t.visit}</h2><div class="visit">
  <div><address>${placeLine(content)}</address>${links.maps ? html`<p><a href="${links.maps}">${t.map}</a></p>` : ''}</div>
  ${content.hours?.length ? html`<div><dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl></div>` : ''}
</div></section>` : ''}
<section class="end"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</section>
</main>`,
};
