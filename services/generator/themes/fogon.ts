import { html } from '../src/core/html';
import { icon, iconFor, type IconName } from '../src/core/icons';
import { areaLine, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/**
 * Food magazine: a full-bleed hero (the first photo, or a bold accent panel with a pattern of food icons),
 * a ticker of what they make, the menu as dotted-leader lines, a round hours sticker, and a big order button.
 * Written with Tailwind (utilities mapped to the page tokens); `css` holds only what utilities can't say.
 */
export const fogon: Theme = {
  id: 'fogon',
  meta: {
    name: 'Fogón',
    industries: ['bakeries', 'taquerías and street food', 'restaurants and fondas', 'cafés', 'juice bars', 'pastry shops', 'catering'],
    moods: ['appetizing', 'bold', 'warm', 'lively'],
    scheme: 'light',
    fontStyles: ['poster', 'contrast', 'serif', 'soft'],
    defaultPalette: { ink: '#231a14', paper: '#fbf5ec', accent: '#c8471d' },
  },
  tailwind: true,
  css: `
.display{font-family:var(--font-display);font-weight:var(--font-display-weight)}
.ticker{display:flex;width:max-content}
.ticker ul{display:flex;gap:2.5rem;padding-right:2.5rem;margin:0;list-style:none}
.ticker li{display:flex;align-items:center;gap:.8rem;white-space:nowrap}
.pattern{background-image:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--on-accent) 22%,transparent) 1.5px,transparent 0);background-size:22px 22px}
.leader{flex:1;min-width:1.5rem;border-bottom:2px dotted color-mix(in srgb,var(--ink) 30%,transparent);transform:translateY(-.35em)}
.signature{position:relative;overflow:hidden}
.hero-img img{width:100%;height:100%;object-fit:cover;will-change:transform}
.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:1.25rem}
@media (prefers-reduced-motion:no-preference){.ticker{animation:tick 38s linear infinite}@keyframes tick{to{transform:translateX(-50%)}}}
.reveal .rv{opacity:0;transform:translateY(20px);transition:opacity .6s ease,transform .6s cubic-bezier(.2,.7,.2,1)}
.reveal .rv.in{opacity:1;transform:none}
`,
  script: `(()=>{if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const img=document.querySelector('.hero-img img');if(img){let t=false;addEventListener('scroll',()=>{if(t)return;t=true;requestAnimationFrame(()=>{const y=Math.min(scrollY,innerHeight);img.style.transform='translateY('+y*0.18+'px) scale(1.06)';t=false})},{passive:true});img.style.transform='scale(1.06)'}if(!('IntersectionObserver'in window))return;const els=[...document.querySelectorAll('.menu li,.card,.about p,.gallery img')];els.forEach((el,i)=>{el.classList.add('rv');el.style.transitionDelay=(i%3)*80+'ms'});document.documentElement.classList.add('reveal');const io=new IntersectionObserver((es)=>{for(const e of es)if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}},{rootMargin:'0px 0px -8% 0px'});els.forEach((el)=>io.observe(el))})();`,
  body: ({ content, links, t, logo, photos, map }) => {
    const items = content.services.map((s) => ({ ...s, icon: iconFor(s.name, s.detail) }));
    const patternIcons: IconName[] = [...new Set([...items.map((i) => i.icon), 'utensils', 'coffee', 'flame', 'soup', 'cake', 'chef'] as IconName[])].filter((name) => name !== 'basket' && name !== 'package').slice(0, 6);
    const place = placeLine(content);
    const firstHours = content.hours?.[0];
    const tickerRow = html`<ul>${items.map((i) => html`<li>${icon(i.icon, 'icon h-6 w-6')}<span>${i.name}</span></li>`)}</ul>`;

    return html`
<header class="absolute inset-x-0 top-0 z-20">
  <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 ${photos.length ? 'text-white' : 'text-on-accent'}">
    <span class="display flex min-w-0 items-center gap-3 text-lg [&_.mark]:h-11 [&_.mark]:w-11 [&_.mark]:rounded-full">${logo}<span class="[overflow-wrap:anywhere]">${content.businessName}</span></span>
    <a href="${links.whatsapp}" class="hidden shrink-0 items-center gap-2 rounded-full border-2 border-current px-4 py-2 text-sm font-semibold md:inline-flex">${icon('chat', 'icon h-4 w-4')}${content.ctaText}</a>
  </div>
</header>

<main>
<section class="relative isolate flex min-h-[88svh] items-end overflow-hidden ${photos.length ? 'bg-ink text-white' : 'bg-accent text-on-accent'}">
  ${photos.length
    ? html`<div class="hero-img absolute inset-0 -z-10">${photos[0]}</div><div class="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/35 to-black/10"></div>`
    : html`<div class="pattern absolute inset-0 -z-10" aria-hidden="true"></div>
      <div class="absolute -right-10 top-24 -z-10 grid grid-cols-3 gap-6 opacity-25 md:right-10 md:top-28 md:gap-10" aria-hidden="true">${patternIcons.map((name, i) => html`<span class="${i % 2 ? 'rotate-12' : '-rotate-6'}">${icon(name, 'icon h-20 w-20 md:h-28 md:w-28')}</span>`)}</div>`}
  <div class="mx-auto w-full max-w-6xl px-5 pb-14 pt-32 md:pb-20">
    ${areaLine(content) ? html`<p class="mb-5 inline-flex items-center gap-2 rounded-full bg-paper/15 px-4 py-2 text-sm font-semibold backdrop-blur">${icon('pin', 'icon h-4 w-4')}${areaLine(content)}</p>` : ''}
    <h1 class="display max-w-[14ch] text-[clamp(2.8rem,10vw,7.5rem)] leading-[.92] tracking-tight [text-wrap:balance]">${content.headline}</h1>
    <div class="signature mt-7 h-1.5 w-24 rounded-full ${photos.length ? 'bg-accent' : 'bg-on-accent'}" aria-hidden="true"></div>
    <p class="mt-6 max-w-[38ch] text-lg opacity-90 md:text-xl">${content.subhead}</p>
    <div class="mt-9 flex flex-wrap gap-3">
      <a href="${links.whatsapp}" class="inline-flex min-h-14 items-center gap-2 rounded-full ${photos.length ? 'bg-accent text-on-accent' : 'bg-paper text-ink'} px-7 text-lg font-bold shadow-lg shadow-black/20">${icon('chat', 'icon h-5 w-5')}${content.ctaText}</a>
      ${links.maps ? html`<a href="${links.maps}" class="inline-flex min-h-14 items-center gap-2 rounded-full border-2 border-current px-6 font-semibold">${icon('navigation', 'icon h-5 w-5')}${t.directions}</a>` : ''}
    </div>
  </div>
  ${firstHours ? html`<div class="absolute bottom-10 right-5 hidden h-40 w-40 rotate-6 place-content-center rounded-full bg-paper p-4 text-center text-ink shadow-xl md:right-12 md:grid">
    ${icon('clock', 'icon mx-auto mb-1 h-6 w-6 text-accent')}<span class="text-xs font-semibold uppercase tracking-widest">${firstHours.days}</span><span class="display mt-1 text-lg leading-tight [font-variant-numeric:tabular-nums]">${firstHours.time}</span>
  </div>` : ''}
</section>

<div class="overflow-hidden border-y-2 border-ink bg-paper py-4 text-lg font-semibold" aria-hidden="true">
  <div class="ticker">${tickerRow}${tickerRow}</div>
</div>

<section class="mx-auto max-w-6xl px-5 py-20 md:py-28">
  <div class="mb-12 flex items-end justify-between gap-6">
    <h2 class="display text-[clamp(2.2rem,6vw,4.2rem)] leading-none">${t.menu}</h2>
    <span class="hidden text-accent md:block">${icon('sparkles', 'icon h-10 w-10')}</span>
  </div>
  <ul class="menu grid gap-x-16 gap-y-8 md:grid-cols-2">
    ${items.map((i) => html`<li class="flex gap-4">
      <span class="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-accent/12 text-accent">${icon(i.icon, 'icon h-6 w-6')}</span>
      <div class="min-w-0 flex-1">
        <div class="flex items-end gap-3"><strong class="display text-xl leading-snug md:text-2xl [overflow-wrap:anywhere]">${i.name}</strong><span class="leader"></span></div>
        ${i.detail ? html`<p class="mt-1.5 text-ink/70">${i.detail}</p>` : ''}
      </div>
    </li>`)}
  </ul>
</section>

<section class="about bg-ink text-paper">
  <div class="mx-auto grid max-w-6xl gap-10 px-5 py-20 md:grid-cols-[1fr_2fr] md:py-28">
    <h2 class="display text-[clamp(2rem,5vw,3.4rem)] leading-none">${t.about}</h2>
    <p class="text-xl leading-relaxed text-paper/85 md:text-2xl [text-wrap:pretty]">${content.about}</p>
  </div>
</section>

${photos.length > 1 ? html`<section class="gallery mx-auto grid max-w-6xl gap-5 px-5 pt-20 sm:grid-cols-2">${photos.slice(1)}</section>` : ''}

<section class="mx-auto grid max-w-6xl gap-5 px-5 py-20 md:grid-cols-2 md:py-28">
  ${content.hours?.length ? html`<div class="card rounded-3xl border-2 border-ink/10 bg-white/60 p-8">
    <h3 class="display mb-6 flex items-center gap-3 text-2xl">${icon('clock', 'icon h-7 w-7 text-accent')}${t.hours}</h3>
    <dl class="divide-y divide-ink/10">${content.hours.map((h) => html`<div class="flex justify-between gap-4 py-3"><dt>${h.days}</dt><dd class="m-0 font-bold [font-variant-numeric:tabular-nums]">${h.time}</dd></div>`)}</dl>
  </div>` : ''}
  ${place ? html`<div class="card rounded-3xl border-2 border-ink/10 bg-white/60 p-8">
    <h3 class="display mb-6 flex items-center gap-3 text-2xl">${icon('pin', 'icon h-7 w-7 text-accent')}${t.address}</h3>
    <address class="mb-6 text-lg not-italic">${place}</address>
    ${map ? html`<div class="mb-6 h-64 overflow-hidden rounded-2xl border-2 border-ink/10 bg-accent/10">${map}</div>` : ''}
    ${links.maps ? html`<a href="${links.maps}" class="inline-flex min-h-12 items-center gap-2 rounded-full border-2 border-ink px-5 font-semibold">${icon('navigation', 'icon h-5 w-5')}${t.directions}</a>` : ''}
  </div>` : ''}
  <div class="card flex flex-col justify-between gap-8 rounded-3xl bg-accent p-8 text-on-accent ${content.hours?.length && place ? 'md:col-span-2 md:flex-row md:items-center' : ''}">
    <p class="display text-[clamp(1.8rem,4vw,3rem)] leading-tight">${content.businessName}</p>
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
      <a href="${links.whatsapp}" class="inline-flex min-h-14 items-center gap-2 rounded-full bg-paper px-7 text-lg font-bold text-ink">${icon('chat', 'icon h-5 w-5')}${content.ctaText}</a>
      ${links.instagram ? html`<a href="${links.instagram}" class="inline-flex min-h-11 items-center gap-2 font-semibold">${icon('camera', 'icon h-5 w-5')}Instagram</a>` : ''}
      ${links.facebook ? html`<a href="${links.facebook}" class="inline-flex min-h-11 items-center gap-2 font-semibold">${icon('users', 'icon h-5 w-5')}Facebook</a>` : ''}
      ${links.phone ? html`<a href="${links.phone}" class="inline-flex min-h-11 items-center gap-2 font-semibold">${icon('phone', 'icon h-5 w-5')}${t.contact}</a>` : ''}
    </div>
  </div>
</section>
</main>

<a href="${links.whatsapp}" class="fixed bottom-4 right-4 z-30 inline-flex min-h-14 items-center gap-2 rounded-full bg-accent px-5 font-bold text-on-accent shadow-xl shadow-black/25 md:hidden">${icon('chat', 'icon h-5 w-5')}WhatsApp</a>
<div class="h-20 md:hidden" aria-hidden="true"></div>`;
  },
};
