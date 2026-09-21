import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Dark and quiet: a framed hero, thin tracked labels, accent hairlines, wide spacing. */
export const nocturno: Theme = {
  id: 'nocturno',
  meta: {
    name: 'Nocturno',
    industries: ['salons and spas', 'restaurants', 'photographers', 'jewelry', 'tattoo studios', 'event venues'],
    moods: ['elegant', 'intimate', 'premium', 'nocturnal'],
    scheme: 'dark',
    fontStyles: ['serif'],
    defaultPalette: { ink: '#efe6d6', paper: '#14110f', accent: '#c9a25d' },
  },
  css: `
.w{width:min(70rem,100% - 2.5rem);margin-inline:auto}
.lab{font-size:.74rem;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);margin:0}
.brand{display:flex;align-items:center;gap:.9rem}.brand .mark{width:2.4rem;height:2.4rem}
.heroimg{margin:0}.heroimg img{aspect-ratio:21/9;filter:saturate(.85)}
.photos{gap:1.5rem}
.hero{padding:clamp(1.2rem,3vw,2rem) 0}
.frame{border:1px solid var(--accent);outline:1px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:.45rem;margin:.45rem;padding:clamp(2.5rem,8vw,6.5rem) clamp(1.5rem,7vw,6rem);display:grid;gap:2rem}
.frame .top{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.hero h1{font-size:clamp(2.6rem,7.4vw,6rem);line-height:1.02;max-width:13ch;margin-left:clamp(0rem,9vw,8rem)}
.hero .sub{max-width:30rem;font-size:1.12rem;opacity:.85;margin:0 0 0 auto}
.signature{position:relative;overflow:hidden;width:1px;height:5rem;background:var(--accent);margin-left:clamp(0rem,9vw,8rem)}
.cta{justify-self:end;display:inline-block;border:1px solid var(--accent);color:var(--accent);padding:1rem 2rem;text-decoration:none;font-size:.85rem;letter-spacing:.22em;text-transform:uppercase}
.cta:hover{background:var(--accent);color:var(--on-accent)}
section{padding:clamp(3rem,8vw,6rem) 0}
.head{display:flex;align-items:center;gap:1.5rem;margin-bottom:2.5rem}
.head::after{content:'';flex:1;height:1px;background:color-mix(in srgb,var(--accent) 50%,transparent)}
.list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:2.4rem 5rem}
.list li:nth-child(even){translate:0 1.6rem}
.list strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.6rem;line-height:1.15;margin-bottom:.35rem}
.list strong::before{content:'◆';font-size:.5em;color:var(--accent);margin-right:.9em;vertical-align:.35em}
.list span{opacity:.75}
.about>p{font-family:var(--font-display);font-size:clamp(1.4rem,3vw,2.2rem);line-height:1.4;max-width:24em;margin:0 0 0 auto}
.visit{display:grid;grid-template-columns:1fr 1fr;gap:3rem}
.visit address{font-style:normal;font-size:1.25rem;line-height:1.5}
.visit a{color:var(--accent)}
.visit dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:.8rem 2rem}
.visit dt{opacity:.75}.visit dd{margin:0}
.end{border-top:1px solid color-mix(in srgb,var(--accent) 50%,transparent);display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:space-between;align-items:center}
.end nav{display:flex;gap:2rem;font-size:.78rem;letter-spacing:.22em;text-transform:uppercase}
@media (max-width:46rem){.hero h1,.signature{margin-left:0}.list,.visit{grid-template-columns:1fr}.list li:nth-child(even){translate:none}.cta{justify-self:start}.hero .sub{margin:0}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<header class="w hero"><div class="frame">
  <div class="top"><p class="lab brand">${logo}${content.businessName}</p><p class="lab">${areaLine(content)}</p></div>
  <div class="signature" aria-hidden="true"></div>
  <h1>${content.headline}</h1>
  <p class="sub">${content.subhead}</p>
  <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
</div></header>
<main class="w">
${photos.length ? html`<figure class="heroimg">${photos[0]}</figure>` : ''}
<section><div class="head"><p class="lab">${t.services}</p></div>
  <ul class="list">${content.services.map((s) => html`<li><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</li>`)}</ul>
</section>
<section class="about"><div class="head"><p class="lab">${t.about}</p></div><p>${content.about}</p></section>
${photos.length > 1 ? html`<section><div class="photos">${photos.slice(1)}</div></section>` : ''}
${hasVisit(content) ? html`<section><div class="head"><p class="lab">${t.visit}</p></div><div class="visit">
  <address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>
  ${content.hours?.length ? html`<dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl>` : ''}
</div></section>` : ''}
<section class="end"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</section>
</main>`,
};
