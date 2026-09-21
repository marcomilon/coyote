import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine, twoDigits } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Magazine page: huge serif headline, hairlines, numbered index, lots of air. */
export const editorial: Theme = {
  id: 'editorial',
  meta: {
    name: 'Editorial',
    industries: ['law and consulting', 'clinics', 'cafés', 'studios', 'bookshops', 'architecture'],
    moods: ['refined', 'calm', 'trustworthy', 'classic'],
    scheme: 'light',
    fontStyles: ['serif', 'contrast'],
    defaultPalette: { ink: '#1c1a17', paper: '#f7f3ea', accent: '#9a3b1f' },
  },
  css: `
.w{width:min(74rem,100% - 2.5rem);margin-inline:auto}
.brand{display:flex;align-items:center;gap:.8rem}.brand .mark{width:2.2rem;height:2.2rem}
.heroimg{margin:0 0 clamp(2.5rem,6vw,4.5rem)}.heroimg img{aspect-ratio:21/9}
.mast{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.4rem 0;border-bottom:1px solid var(--ink);font-size:.78rem;letter-spacing:.16em;text-transform:uppercase}
.hero{display:grid;grid-template-columns:repeat(12,1fr);gap:1.5rem;padding:clamp(3rem,9vw,7rem) 0 clamp(3rem,7vw,5rem)}
.hero h1{grid-column:1/11;font-size:clamp(2.7rem,8.4vw,7rem);line-height:.98;letter-spacing:-.02em}
.hero .side{grid-column:8/13;margin-top:1.5rem;padding-left:1.4rem;border-left:1px solid var(--ink)}
.hero .side p{font-size:1.12rem;margin:0 0 1.5rem}
.signature{position:relative;overflow:hidden;grid-column:1/7;align-self:end;height:.5rem;background:var(--accent)}
.cta{display:inline-block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.25rem;color:var(--accent);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.3em}
.cta::after{content:' →'}
section{border-top:1px solid var(--ink);padding:clamp(2.5rem,6vw,4.5rem) 0}
.label{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;margin:0 0 2rem;color:var(--accent)}
.index{list-style:none;margin:0;padding:0;columns:2;column-gap:4rem}
.index li{break-inside:avoid;display:grid;grid-template-columns:3rem 1fr;gap:.5rem;padding:1.1rem 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 22%,transparent)}
.index i{font-style:normal;font-size:.85rem;padding-top:.45rem;color:var(--accent)}
.index strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.45rem;line-height:1.15}
.about{display:grid;grid-template-columns:repeat(12,1fr);gap:1.5rem}
.about .label{grid-column:1/4}
.about p:not(.label){grid-column:4/12;margin:0;font-family:var(--font-display);font-size:clamp(1.35rem,2.6vw,2rem);line-height:1.35}
.about p:not(.label)::first-letter{font-size:3.1em;float:left;line-height:.85;padding:.06em .1em 0 0;color:var(--accent);font-weight:var(--font-display-weight)}
.visit{display:grid;grid-template-columns:1fr 1.3fr;gap:3rem}
.visit address{font-style:normal;font-size:1.2rem}
.visit table{width:100%;border-collapse:collapse}
.visit td{padding:.7rem 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 22%,transparent)}
.visit td:last-child{text-align:right}
.end{display:flex;flex-wrap:wrap;gap:1.5rem 3rem;align-items:baseline;justify-content:space-between}
.end .cta{font-size:clamp(1.8rem,5vw,3.4rem)}
.end nav{display:flex;gap:1.5rem;font-size:.85rem;letter-spacing:.12em;text-transform:uppercase}
@media (max-width:48rem){.hero h1,.hero .side,.signature,.about .label,.about p:not(.label){grid-column:1/-1}.hero .side{border:0;padding:0}.index{columns:1}.visit{grid-template-columns:1fr}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<header class="w mast"><span class="brand">${logo}${content.businessName}</span><span>${areaLine(content)}</span></header>
<div class="w hero">
  <h1>${content.headline}</h1>
  <div class="signature" aria-hidden="true"></div>
  <div class="side"><p>${content.subhead}</p><a class="cta" href="${links.whatsapp}">${content.ctaText}</a></div>
</div>
<main class="w">
${photos.length ? html`<figure class="heroimg">${photos[0]}</figure>` : ''}
<section><p class="label">${t.services}</p>
  <ol class="index">${content.services.map((s, i) => html`<li><i>${twoDigits(i + 1)}</i><div><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</div></li>`)}</ol>
</section>
<section class="about"><p class="label">${t.about}</p><p>${content.about}</p></section>
${photos.length > 1 ? html`<section><div class="photos">${photos.slice(1)}</div></section>` : ''}
${hasVisit(content) ? html`<section><p class="label">${t.visit}</p><div class="visit">
  <address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>
  ${content.hours?.length ? html`<table>${content.hours.map((h) => html`<tr><td>${h.days}</td><td>${h.time}</td></tr>`)}</table>` : ''}
</div></section>` : ''}
<section class="end"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</section>
</main>`,
};
