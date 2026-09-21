import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Information first: a top strip, a headline beside an info card with hours and address, a checklist. */
export const clinico: Theme = {
  id: 'clinico',
  meta: {
    name: 'Clínico',
    industries: ['dentists and doctors', 'veterinarians', 'pharmacies', 'accountants', 'laboratories', 'physiotherapy', 'repair services'],
    moods: ['clean', 'clear', 'professional', 'reassuring'],
    scheme: 'light',
    fontStyles: ['sans'],
    defaultPalette: { ink: '#12263a', paper: '#f6f9fb', accent: '#0f7b6c' },
  },
  css: `
.w{width:min(72rem,100% - 2.5rem);margin-inline:auto}
.brand{display:flex;align-items:center;gap:.6rem}.brand .mark{width:1.8rem;height:1.8rem}
.heroimg{margin:0 0 clamp(2rem,5vw,3.5rem)}.heroimg img{border-radius:.8rem;aspect-ratio:21/9}
.photos img{border-radius:.6rem}
.strip{background:var(--ink);color:var(--paper);font-size:.88rem}
.strip .w{display:flex;flex-wrap:wrap;gap:.4rem 2rem;justify-content:space-between;padding:.65rem 0}
.hero{display:grid;grid-template-columns:1.35fr 1fr;gap:clamp(2rem,5vw,4.5rem);align-items:center;padding:clamp(2.5rem,7vw,5.5rem) 0}
.name{font-weight:600;color:var(--accent);margin:0 0 1rem;display:flex;align-items:center;gap:.8rem}
.signature{position:relative;overflow:hidden;display:inline-block;width:1.1rem;height:1.1rem;border-radius:.3rem;background:var(--accent)}
.hero h1{font-size:clamp(2.2rem,5.6vw,4.2rem);line-height:1.05;letter-spacing:-.02em}
.hero .sub{font-size:1.15rem;max-width:32rem;margin:1.3rem 0 0}
.card{background:#fff;border:1px solid color-mix(in srgb,var(--ink) 16%,transparent);border-top:5px solid var(--accent);border-radius:.8rem;padding:1.7rem;box-shadow:0 1.2rem 2.5rem -1.2rem color-mix(in srgb,var(--ink) 35%,transparent)}
.card h2{font-size:1.05rem;margin-bottom:1rem}
.card dl{margin:0 0 1.2rem;display:grid;grid-template-columns:1fr auto;gap:.45rem 1rem;font-size:.98rem}
.card dd{margin:0;font-weight:600}
.card address{font-style:normal;margin-bottom:1.3rem}
.cta{display:block;text-align:center;background:var(--accent);color:var(--on-accent);border-radius:.6rem;padding:1rem 1.4rem;font-weight:600;text-decoration:none}
.cta:hover{filter:brightness(1.08)}
section{padding:clamp(2.5rem,6vw,4.5rem) 0;border-top:1px solid color-mix(in srgb,var(--ink) 14%,transparent)}
.split{display:grid;grid-template-columns:1fr 2.2fr;gap:2rem 4rem}
.split h2{font-size:clamp(1.5rem,3.2vw,2.1rem)}
.checks{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:1.4rem 2.5rem}
.checks li{display:grid;grid-template-columns:1.6rem 1fr;gap:.7rem}
.checks li::before{content:'✓';display:grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:color-mix(in srgb,var(--accent) 18%,var(--paper));color:var(--accent);font-weight:700;font-size:.85rem}
.checks strong{display:block;font-size:1.08rem}
.checks span{font-size:.97rem;opacity:.85}
.split p{margin:0;font-size:1.1rem;line-height:1.65;max-width:40rem}
.end{background:color-mix(in srgb,var(--accent) 10%,var(--paper))}
.end .w{display:flex;flex-wrap:wrap;gap:1.2rem 2rem;align-items:center;justify-content:space-between}
.end .cta{display:inline-block}
.end nav{display:flex;gap:1.4rem;font-weight:600}
@media (max-width:50rem){.hero,.split{grid-template-columns:1fr}.checks{grid-template-columns:1fr}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<div class="strip"><div class="w"><span class="brand">${logo}${content.businessName}</span><span>${areaLine(content)}</span></div></div>
<header class="w hero">
  <div><p class="name"><span class="signature" aria-hidden="true"></span>${content.businessName}</p><h1>${content.headline}</h1><p class="sub">${content.subhead}</p></div>
  <aside class="card">
    ${hasVisit(content) ? html`<h2>${t.visit}</h2>
    ${content.hours?.length ? html`<dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl>` : ''}
    ${placeLine(content) ? html`<address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>` : ''}` : html`<h2>${t.contact}</h2>`}
    <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  </aside>
</header>
<main>
${photos.length ? html`<div class="w"><figure class="heroimg">${photos[0]}</figure></div>` : ''}
<section><div class="w split"><h2>${t.services}</h2>
  <ul class="checks">${content.services.map((s) => html`<li><div><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</div></li>`)}</ul>
</div></section>
<section><div class="w split"><h2>${t.about}</h2><p>${content.about}</p></div></section>
${photos.length > 1 ? html`<section><div class="w"><div class="photos">${photos.slice(1)}</div></div></section>` : ''}
</main>
<section class="end"><div class="w"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</div></section>`,
};
