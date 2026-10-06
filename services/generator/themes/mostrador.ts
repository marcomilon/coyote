import { html } from '../src/core/html';
import { icon, iconFor } from '../src/core/icons';
import { areaLine, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/**
 * Neighborhood shop: a striped awning with a scalloped edge (not the signature: the model's signatureCss
 * restyles only the round sticker on the shop window), the name painted big like a shop sign, a shop
 * window (the first photo under an arch, or a display of big product icons when there are no photos),
 * products as price tags, and a WhatsApp button always in reach.
 */
export const mostrador: Theme = {
  id: 'mostrador',
  meta: {
    name: 'Mostrador',
    industries: ['mini markets and bodegas', 'hardware stores', 'bookshops and stationery', 'clothing and shoe shops', 'pharmacies', 'pet shops', 'gift shops'],
    moods: ['warm', 'friendly', 'local', 'lively'],
    scheme: 'light',
    fontStyles: ['sans', 'soft', 'poster', 'contrast'],
    defaultPalette: { ink: '#1f2a24', paper: '#fbf7ef', accent: '#d9482b' },
  },
  css: `
:root{--tint:color-mix(in srgb,var(--accent) 13%,var(--paper));--line:color-mix(in srgb,var(--ink) 14%,transparent);--card:color-mix(in srgb,#fff 70%,var(--paper));--muted:color-mix(in srgb,var(--ink) 68%,var(--paper))}
.w{width:min(72rem,100% - 2.5rem);margin-inline:auto}
.icon{width:1.25em;height:1.25em;flex:none}
.awning{height:3.2rem;background:repeating-linear-gradient(90deg,var(--accent) 0 3rem,var(--tint) 3rem 6rem);-webkit-mask:linear-gradient(#000 0 0) top/100% calc(100% - 1.5rem) no-repeat,radial-gradient(circle at 50% 0,#000 1.5rem,#0000 calc(1.5rem + .5px)) bottom/3rem 1.5rem repeat-x;mask:linear-gradient(#000 0 0) top/100% calc(100% - 1.5rem) no-repeat,radial-gradient(circle at 50% 0,#000 1.5rem,#0000 calc(1.5rem + .5px)) bottom/3rem 1.5rem repeat-x}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.8rem 1.5rem;padding:1.1rem 0 .4rem}
.brand{display:flex;align-items:center;gap:.7rem;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.1rem;min-width:0;overflow-wrap:anywhere}
.brand .mark{width:2.6rem;height:2.6rem;border-radius:.7rem}
.chip{display:inline-flex;align-items:center;gap:.45rem;padding:.45rem .85rem;border-radius:999px;background:var(--tint);font-size:.9rem;font-weight:600;font-variant-numeric:tabular-nums}
.chip .icon{color:var(--accent)}
.hero{display:grid;gap:2.2rem;align-items:center;padding:clamp(1.8rem,5vw,4rem) 0 clamp(2.5rem,6vw,5rem)}
.eyebrow{display:inline-flex;align-items:center;gap:.4rem;margin:0 0 1rem;font-size:.95rem;font-weight:600;color:var(--accent)}
.hero h1{font-size:clamp(2.5rem,8.5vw,5.2rem);line-height:.98;letter-spacing:-.02em;margin:0 0 1.1rem}
.hero .lead{font-size:clamp(1.08rem,2.2vw,1.3rem);max-width:34ch;margin:0 0 1.8rem;color:var(--muted);text-wrap:pretty}
.actions{display:flex;flex-wrap:wrap;gap:.8rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.55rem;min-height:3.2rem;padding:.8rem 1.4rem;border-radius:999px;font-weight:700;text-decoration:none;border:2px solid var(--accent)}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn.ghost{color:var(--ink);border-color:var(--line);background:var(--card)}
.window{position:relative}
.signature{position:absolute;overflow:hidden;top:1.2rem;right:-.4rem;width:4.6rem;height:4.6rem;border-radius:50%;background:var(--accent);box-shadow:0 .6rem 1.2rem -.6rem color-mix(in srgb,var(--ink) 50%,transparent);transform:rotate(12deg)}
.signature .icon{position:absolute;inset:0;margin:auto;width:1.9rem;height:1.9rem;color:var(--on-accent)}
.signature::after{content:'';position:absolute;inset:.45rem;border-radius:50%;border:2px dashed color-mix(in srgb,var(--on-accent) 70%,transparent)}
.window .arch{margin:0;border-radius:14rem 14rem 1.4rem 1.4rem;overflow:hidden;border:.5rem solid var(--card);box-shadow:0 1.5rem 3rem -1.5rem color-mix(in srgb,var(--ink) 45%,transparent)}
.window .arch img{aspect-ratio:4/3;width:100%;height:100%;object-fit:cover}
.display{display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;padding:1.2rem;border-radius:14rem 14rem 1.4rem 1.4rem;background:var(--tint);padding-top:4.5rem}
.display span{display:grid;place-items:center;aspect-ratio:1;border-radius:1.2rem;background:var(--card);color:var(--accent);box-shadow:0 .6rem 1.2rem -.8rem color-mix(in srgb,var(--ink) 40%,transparent)}
.display span:nth-child(odd){transform:rotate(-3deg)}.display span:nth-child(even){transform:rotate(2.5deg) translateY(.4rem)}
.display .icon{width:48%;height:48%;stroke-width:1.6}
section{padding:clamp(2.8rem,7vw,5rem) 0}
.head{display:flex;align-items:center;gap:.7rem;margin:0 0 1.8rem}
.head h2{font-size:clamp(1.7rem,4.5vw,2.6rem);line-height:1.05}
.head::before{content:'';width:.9rem;height:.9rem;border-radius:50%;background:var(--accent);flex:none}
.shelf{list-style:none;margin:0;padding:0;display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))}
.shelf li{position:relative;display:flex;gap:1rem;align-items:flex-start;padding:1.2rem 1.2rem 1.2rem 1.1rem;border:1.5px solid var(--line);border-radius:1rem;background:var(--card);min-width:0}
.shelf li::after{content:'';position:absolute;top:.9rem;right:.9rem;width:.55rem;height:.55rem;border-radius:50%;border:1.5px solid var(--line);background:var(--paper)}
.shelf .pic{display:grid;place-items:center;width:3rem;height:3rem;border-radius:.8rem;background:var(--tint);color:var(--accent);flex:none}
.shelf strong{display:block;font-family:var(--font-display);font-weight:var(--font-display-weight);font-size:1.15rem;line-height:1.2;margin-top:.25rem;padding-right:1rem;overflow-wrap:anywhere}
.shelf small{display:block;margin-top:.3rem;font-size:.95rem;color:var(--muted)}
.band{background:var(--tint)}
.band p{margin:0;max-width:44ch;font-size:clamp(1.2rem,2.6vw,1.6rem);line-height:1.5;text-wrap:pretty}
.visit{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr))}
.card{padding:1.4rem;border-radius:1.2rem;background:var(--card);border:1.5px solid var(--line)}
.card h3{display:flex;align-items:center;gap:.5rem;font-size:1.25rem;margin:0 0 1rem}
.card h3 .icon{color:var(--accent)}
.card table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.card td{padding:.65rem 0;border-bottom:1px dashed var(--line)}
.card tr:last-child td{border-bottom:0}
.card td:last-child{text-align:right;font-weight:700}
.card address{font-style:normal;font-size:1.1rem;margin:0 0 1.2rem}
.mapbox{height:15rem;margin:0 0 1.2rem;border-radius:.9rem;overflow:hidden;border:1.5px solid var(--line);background:var(--tint)}
.gallery{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));margin-top:1rem}
.gallery img{border-radius:1.2rem;aspect-ratio:4/3;width:100%;object-fit:cover}
.end{background:var(--accent);color:var(--on-accent);text-align:center}
.end h2{font-size:clamp(2rem,6vw,3.6rem);line-height:1;margin:0 auto 1.6rem;max-width:18ch}
.end .btn.primary{background:var(--on-accent);color:var(--accent);border-color:var(--on-accent);font-size:1.1rem}
.social{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem 1.4rem;margin-top:1.6rem}
.social a{display:inline-flex;align-items:center;gap:.45rem;min-height:2.75rem;color:inherit;font-weight:600}
.float{position:fixed;right:1rem;bottom:max(1rem,env(safe-area-inset-bottom));z-index:10;display:inline-flex;align-items:center;gap:.5rem;min-height:3.4rem;padding:.8rem 1.2rem;border-radius:999px;background:var(--accent);color:var(--on-accent);font-weight:700;text-decoration:none;box-shadow:0 .8rem 2rem -.6rem color-mix(in srgb,var(--ink) 55%,transparent)}
@media (min-width:52rem){.hero{grid-template-columns:1.15fr .85fr;gap:4rem}.window .arch img{aspect-ratio:4/5}.float{display:none}}
@media (max-width:51.99rem){body{padding-bottom:5rem}}
/* Scroll reveal: the script adds .reveal to <html> only when it runs and motion is allowed. */
.reveal .rv{opacity:0;transform:translateY(18px);transition:opacity .55s ease,transform .55s cubic-bezier(.2,.7,.2,1)}
.reveal .rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:no-preference){.shelf li{transition:transform .2s ease}.shelf li:hover{transform:translateY(-3px)}.hero h1,.hero .lead,.actions{animation:rise .6s cubic-bezier(.2,.7,.2,1) both}.hero .lead{animation-delay:.08s}.actions{animation-delay:.16s}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}}
`,
  script: `(()=>{if(!('IntersectionObserver'in window)||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const els=[...document.querySelectorAll('.shelf li,.visit .card,.band p,.gallery img,.window')];els.forEach((el,i)=>{el.classList.add('rv');el.style.transitionDelay=(i%4)*70+'ms'});document.documentElement.classList.add('reveal');const io=new IntersectionObserver((entries)=>{for(const e of entries)if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}},{rootMargin:'0px 0px -8% 0px'});els.forEach((el)=>io.observe(el))})();`,
  body: ({ content, links, t, logo, photos, map }) => {
    const firstHours = content.hours?.[0];
    const shown = content.services.slice(0, 6).map((s) => iconFor(s.name, s.detail));
    const tiles = shown.length >= 3 ? shown : [...shown, 'basket' as const, 'package' as const, 'store' as const].slice(0, 3);
    const place = placeLine(content);
    return html`
<div class="awning" aria-hidden="true"></div>
<header class="w top">
  <span class="brand">${logo}${content.businessName}</span>
  ${firstHours ? html`<span class="chip">${icon('clock')}${firstHours.days} · ${firstHours.time}</span>` : ''}
</header>
<main>
<div class="w hero">
  <div>
    ${areaLine(content) ? html`<p class="eyebrow">${icon('pin')}${areaLine(content)}</p>` : ''}
    <h1>${content.headline}</h1>
    <p class="lead">${content.subhead}</p>
    <div class="actions">
      <a class="btn primary" href="${links.whatsapp}">${icon('chat')}${content.ctaText}</a>
      ${links.maps ? html`<a class="btn ghost" href="${links.maps}">${icon('navigation')}${t.directions}</a>` : ''}
    </div>
  </div>
  <div class="window">
    <div class="signature" aria-hidden="true">${icon('sparkles')}</div>
    ${photos.length
      ? html`<figure class="arch">${photos[0]}</figure>`
      : html`<div class="display" aria-hidden="true">${tiles.map((name) => html`<span>${icon(name)}</span>`)}</div>`}
  </div>
</div>

<section class="w">
  <div class="head"><h2>${t.products}</h2></div>
  <ul class="shelf">${content.services.map(
    (s) => html`<li><span class="pic">${icon(iconFor(s.name, s.detail))}</span><div><strong>${s.name}</strong>${s.detail ? html`<small>${s.detail}</small>` : ''}</div></li>`,
  )}</ul>
</section>

<section class="band"><div class="w">
  <div class="head"><h2>${t.about}</h2></div>
  <p>${content.about}</p>
</div></section>

${content.hours?.length || place ? html`<section class="w">
  <div class="head"><h2>${t.visit}</h2></div>
  <div class="visit">
    ${content.hours?.length ? html`<div class="card"><h3>${icon('clock')}${t.hours}</h3><table>${content.hours.map((h) => html`<tr><td>${h.days}</td><td>${h.time}</td></tr>`)}</table></div>` : ''}
    ${place ? html`<div class="card"><h3>${icon('pin')}${t.address}</h3><address>${place}</address>${map ? html`<div class="mapbox">${map}</div>` : ''}${links.maps ? html`<a class="btn ghost" href="${links.maps}">${icon('navigation')}${t.directions}</a>` : ''}</div>` : ''}
  </div>
  ${photos.length > 1 ? html`<div class="gallery">${photos.slice(1)}</div>` : ''}
</section>` : photos.length > 1 ? html`<section class="w"><div class="gallery">${photos.slice(1)}</div></section>` : ''}

<section class="end"><div class="w">
  <h2>${content.businessName}</h2>
  <a class="btn primary" href="${links.whatsapp}">${icon('chat')}${content.ctaText}</a>
  <nav class="social">
    ${links.phone ? html`<a href="${links.phone}">${icon('phone')}${t.contact}</a>` : ''}
    ${links.email ? html`<a href="${links.email}">${icon('mail')}Email</a>` : ''}
    ${links.instagram ? html`<a href="${links.instagram}">${icon('camera')}Instagram</a>` : ''}
    ${links.facebook ? html`<a href="${links.facebook}">${icon('users')}Facebook</a>` : ''}
  </nav>
</div></section>
</main>
<a class="float" href="${links.whatsapp}">${icon('chat')}WhatsApp</a>`;
  },
};
