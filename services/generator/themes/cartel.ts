import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine, twoDigits } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** Street poster: accent-colored hero, enormous uppercase type, thick borders, a rotated sticker. */
export const cartel: Theme = {
  id: 'cartel',
  meta: {
    name: 'Cartel',
    industries: ['gyms', 'mechanics', 'barbers', 'street food', 'hardware stores', 'print shops'],
    moods: ['bold', 'loud', 'direct', 'energetic'],
    scheme: 'light',
    fontStyles: ['poster', 'contrast'],
    defaultPalette: { ink: '#111111', paper: '#f3efe6', accent: '#e4342b' },
  },
  css: `
.w{width:min(76rem,100% - 2rem);margin-inline:auto}
.hero{background:var(--accent);color:var(--on-accent);border-bottom:6px solid var(--ink);padding:1.2rem 0 clamp(2.5rem,7vw,5rem);position:relative;overflow:hidden}
.top{display:flex;justify-content:space-between;gap:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:.85rem;margin-bottom:clamp(2rem,6vw,4.5rem)}
.hero h1{font-size:clamp(3rem,11.5vw,9.5rem);line-height:.88;text-transform:uppercase;letter-spacing:-.01em;max-width:12ch}
.hero p{font-size:1.2rem;font-weight:600;max-width:34rem;margin:1.8rem 0 2rem}
.sticker{position:absolute;right:clamp(1rem,6vw,6rem);bottom:clamp(1.5rem,5vw,4rem);rotate:-8deg;background:var(--paper);color:var(--ink);border:4px solid var(--ink);padding:.9rem 1.2rem;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(1rem,2.2vw,1.6rem);text-transform:uppercase;max-width:14ch;line-height:1;box-shadow:6px 6px 0 var(--ink)}
.signature{position:relative;overflow:hidden;height:1.1rem;width:min(22rem,60%);background:var(--ink);margin-bottom:1.5rem}
.cta{display:inline-block;background:var(--ink);color:var(--paper);font-family:var(--font-display);font-weight:var(--font-display-weight);text-transform:uppercase;letter-spacing:.04em;font-size:1.15rem;padding:1.1rem 1.6rem;text-decoration:none;border:4px solid var(--ink)}
.cta:hover{background:var(--paper);color:var(--ink)}
section{padding:clamp(2.5rem,7vw,5rem) 0}
h2{font-size:clamp(2rem,6vw,4.2rem);text-transform:uppercase;line-height:.9;margin-bottom:2rem}
.rows{list-style:none;margin:0;padding:0;border-top:6px solid var(--ink)}
.rows li{display:grid;grid-template-columns:clamp(3.5rem,10vw,8rem) 1fr;align-items:center;gap:1rem;border-bottom:3px solid var(--ink);padding:1.1rem 0}
.rows i{font-style:normal;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:clamp(2.2rem,6vw,4.5rem);line-height:1;color:var(--accent)}
.rows strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);text-transform:uppercase;font-size:clamp(1.3rem,3vw,2rem);line-height:1.05}
.inv{background:var(--ink);color:var(--paper)}
.inv .w{display:grid;grid-template-columns:1fr 1.6fr;gap:2rem 4rem;align-items:start}
.inv p{font-size:clamp(1.15rem,2.2vw,1.5rem);margin:0;line-height:1.45}
.visit{display:grid;grid-template-columns:1.2fr 1fr;border:6px solid var(--ink)}
.visit>div{padding:1.6rem}
.visit>div+div{border-left:6px solid var(--ink);background:color-mix(in srgb,var(--accent) 16%,var(--paper))}
.visit address{font-style:normal;font-size:1.3rem;font-weight:600}
.visit dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:.5rem 1.5rem;font-weight:600}
.visit dd{margin:0}
.bar{background:var(--accent);color:var(--on-accent);border-top:6px solid var(--ink)}
.bar .w{display:flex;flex-wrap:wrap;gap:1.5rem;align-items:center;justify-content:space-between}
.bar nav{display:flex;gap:1.5rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
@media (max-width:48rem){.sticker{position:static;display:inline-block;margin-top:2rem}.inv .w,.visit{grid-template-columns:1fr}.visit>div+div{border-left:0;border-top:6px solid var(--ink)}}
`,
  body: ({ content, links, t }) => html`
<header class="hero"><div class="w">
  <div class="top"><span>${content.businessName}</span><span>${areaLine(content)}</span></div>
  <div class="signature" aria-hidden="true"></div>
  <h1>${content.headline}</h1>
  <p>${content.subhead}</p>
  <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <div class="sticker" aria-hidden="true">${content.businessName}</div>
</div></header>
<main>
<section><div class="w"><h2>${t.services}</h2>
  <ol class="rows">${content.services.map((s, i) => html`<li><i>${twoDigits(i + 1)}</i><div><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</div></li>`)}</ol>
</div></section>
<section class="inv"><div class="w"><h2>${t.about}</h2><p>${content.about}</p></div></section>
${hasVisit(content) ? html`<section><div class="w"><h2>${t.visit}</h2><div class="visit">
  <div><address>${placeLine(content)}</address>${links.maps ? html`<p><a href="${links.maps}">${t.map}</a></p>` : ''}</div>
  <div>${content.hours?.length ? html`<dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl>` : ''}</div>
</div></div></section>` : ''}
</main>
<section class="bar"><div class="w"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</div></section>`,
};
