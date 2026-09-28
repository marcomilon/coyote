import { html } from '../src/core/html';
import { areaLine, hasVisit, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/** A letter from the owner: one narrow column, a letterhead, the story first, a signature, and an airmail envelope with the address and a stamp with the hours. */
export const carta: Theme = {
  id: 'carta',
  meta: {
    name: 'Carta',
    industries: ['psychologists and therapists', 'tutors and teachers', 'photographers', 'nutritionists', 'translators', 'independent professionals'],
    moods: ['personal', 'warm', 'honest', 'calm'],
    scheme: 'light',
    fontStyles: ['serif'],
    defaultPalette: { ink: '#1f2433', paper: '#fbf8f1', accent: '#2f5d8a' },
  },
  css: `
.page{width:min(42rem,100% - 2.5rem);margin-inline:auto}
.head{display:flex;align-items:center;gap:1rem;padding:clamp(2rem,6vw,3.5rem) 0 1.1rem;border-bottom:1px solid var(--ink);box-shadow:0 5px 0 -4px var(--ink)}
.head .mark{width:2.8rem;height:2.8rem}
.head b{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.25rem;line-height:1.2}
.head span{font-size:.88rem;opacity:.8}
.open{padding:clamp(2.5rem,7vw,4.5rem) 0 1rem}
.open h1{font-size:clamp(2.2rem,6vw,3.6rem);line-height:1.08}
.open p{font-size:1.2rem;margin:1.2rem 0 1.8rem;max-width:32rem}
.cta{display:inline-block;background:var(--accent);color:var(--on-accent);padding:.9rem 1.5rem;border-radius:2rem;text-decoration:none;font-weight:600;text-wrap:balance}
.cta:hover{background:var(--ink);color:var(--paper)}
.polaroid{margin:2.5rem 0 1rem;padding:.7rem .7rem 2.2rem;background:color-mix(in srgb,var(--ink) 4%,var(--paper));border:1px solid color-mix(in srgb,var(--ink) 15%,transparent);rotate:-1.2deg}
.photos{margin:2rem 0}
.letter{font-size:clamp(1.12rem,1.6vw,1.25rem);line-height:1.7}
.letter>p{margin:2.2rem 0}
h2{font-size:1.3rem;margin:2.5rem 0 .6rem}
.offer{list-style:none;margin:0;padding:0}
.offer li{padding:.3rem 0 .3rem 1.8rem;text-indent:-1.8rem}
.offer li::before{content:'—';display:inline-block;width:1.8rem;text-indent:0;color:var(--accent)}
.offer span{opacity:.8}
.sign{margin:3rem 0 0}
.signature{position:relative;overflow:hidden;width:min(15rem,70%);height:3.5rem;border-bottom:1px solid var(--ink)}
.sign p{margin:.5rem 0 0;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.15rem}
.env{margin:clamp(3rem,8vw,5rem) 0 2rem;border:.5rem solid transparent;background:linear-gradient(var(--paper),var(--paper)) padding-box,repeating-linear-gradient(135deg,var(--accent) 0 1rem,var(--paper) 1rem 2rem,var(--ink) 2rem 3rem,var(--paper) 3rem 4rem) border-box;padding:clamp(1.5rem,5vw,2.5rem);min-height:13rem;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1.5rem}
.env .to{align-self:end}
.env h2{margin:0 0 .4rem;font-family:var(--font-body);font-weight:600;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;line-height:1.5}
.env address{font-style:normal;font-size:1.15rem;line-height:1.5}
.stamp{margin:0;align-self:start;max-width:12rem;padding:.8rem 1rem;border:2px dashed var(--accent);color:var(--accent);rotate:-4deg;font-size:.85rem;line-height:1.35}
.stamp dd{margin:0 0 .5rem;font-weight:600}.stamp dd:last-child{margin:0}
.end{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center;padding:1rem 0 3rem}
.end nav{display:flex;gap:1.4rem}
@media (max-width:34rem){.env{grid-template-columns:1fr}.stamp{justify-self:end;order:-1}}
`,
  body: ({ content, links, t, logo, photos }) => html`
<div class="page">
<header class="head">${logo}<div><b>${content.businessName}</b>${areaLine(content) ? html`<span>${areaLine(content)}</span>` : ''}</div></header>
<main>
<div class="open"><h1>${content.headline}</h1><p>${content.subhead}</p><a class="cta" href="${links.whatsapp}">${content.ctaText}</a></div>
${photos.length ? html`<figure class="polaroid">${photos[0]}</figure>` : ''}
<div class="letter">
  <p>${content.about}</p>
  <h2>${t.services}</h2>
  <ul class="offer">${content.services.map((s) => html`<li>${s.name}${s.detail ? html`<span>, ${s.detail}</span>` : ''}</li>`)}</ul>
  <div class="sign"><div class="signature" aria-hidden="true"></div><p>${content.businessName}</p></div>
</div>
${photos.length > 1 ? html`<div class="photos">${photos.slice(1)}</div>` : ''}
${hasVisit(content) ? html`<section class="env">
  <div class="to"><h2>${t.visit}</h2>${placeLine(content) ? html`<address>${placeLine(content)}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>` : ''}</div>
  ${content.hours?.length ? html`<dl class="stamp">${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl>` : ''}
</section>` : ''}
<div class="end"><a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
  <nav>${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}</nav>
</div>
</main>
</div>`,
};
