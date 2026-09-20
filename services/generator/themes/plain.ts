import { html } from '../src/core/html';
import type { Theme } from '../src/core/theme';

/** Throwaway theme used to build and test the pipeline. Phase 2a replaces it with the real library. */
export const plain: Theme = {
  id: 'plain',
  meta: {
    name: 'Plain',
    industries: ['any'],
    moods: ['simple', 'direct'],
    scheme: 'light',
  },
  css: `
.wrap{max-width:68rem;margin:0 auto;padding:0 1.25rem}
.hero{padding:4.5rem 0 3.5rem;border-bottom:1px solid color-mix(in srgb,var(--ink) 15%,transparent)}
.hero .name{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase;margin:0 0 1.5rem}
.hero h1{font-size:clamp(2.4rem,7vw,5rem);max-width:14ch}
.hero .sub{font-size:1.15rem;max-width:36rem;margin:1.25rem 0 2rem}
.signature{position:relative;overflow:hidden;height:.6rem;width:8rem;background:var(--accent);margin-bottom:2rem}
.cta{display:inline-block;background:var(--accent);color:var(--paper);padding:.9rem 1.4rem;text-decoration:none;font-weight:600;border-radius:.25rem}
section{padding:3.5rem 0}
section h2{font-size:1.6rem;margin-bottom:1.5rem}
.services{display:grid;gap:1.5rem 3rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));list-style:none;padding:0;margin:0}
.services li{border-top:2px solid var(--ink);padding-top:.75rem}
.services strong{display:block;font-family:var(--font-display);font-size:1.15rem}
.about p{max-width:42rem;font-size:1.05rem;margin:0}
.visit{display:grid;gap:2rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.visit dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.5rem}
.visit dd{margin:0}
.contact{background:var(--ink);color:var(--paper)}
.contact .links{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center}
`,
  body: ({ content, links, t }) => html`
<header class="hero"><div class="wrap">
  <p class="name">${content.businessName}</p>
  <div class="signature" aria-hidden="true"></div>
  <h1>${content.headline}</h1>
  <p class="sub">${content.subhead}</p>
  <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
</div></header>
<main>
<section><div class="wrap">
  <h2>${t.services}</h2>
  <ul class="services">${content.services.map(
    (s) => html`<li><strong>${s.name}</strong>${s.detail ? html`<span>${s.detail}</span>` : ''}</li>`,
  )}</ul>
</div></section>
<section class="about"><div class="wrap">
  <h2>${t.about}</h2>
  <p>${content.about}</p>
</div></section>
${
  content.contact.address || content.location.city || content.hours?.length
    ? html`<section><div class="wrap">
  <h2>${t.visit}</h2>
  <div class="visit">
    <address>${[content.contact.address, content.location.neighborhood, content.location.city]
      .filter(Boolean)
      .join(', ')}${links.maps ? html`<br><a href="${links.maps}">${t.map}</a>` : ''}</address>
    ${
      content.hours?.length
        ? html`<dl>${content.hours.map((h) => html`<dt>${h.days}</dt><dd>${h.time}</dd>`)}</dl>`
        : ''
    }
  </div>
</div></section>`
    : ''
}
<section class="contact"><div class="wrap">
  <h2>${t.contact}</h2>
  <div class="links">
    <a class="cta" href="${links.whatsapp}">${content.ctaText}</a>
    ${links.instagram ? html`<a href="${links.instagram}">Instagram</a>` : ''}
    ${links.facebook ? html`<a href="${links.facebook}">Facebook</a>` : ''}
  </div>
</div></section>
</main>`,
};
