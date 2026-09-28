import { html } from '../src/core/html';
import { icon, iconFor, type IconName } from '../src/core/icons';
import { areaLine, placeLine } from '../src/core/parts';
import type { Theme } from '../src/core/theme';

/**
 * Beauty studio: an editorial split hero (a big serif headline beside a tall arched photo, with a slowly
 * turning "book on WhatsApp" seal), the services as a price list with dotted leaders, an italic quote-style
 * about, a gallery, and hours with the map. With no photos, the arch is a soft gradient with a large icon.
 * Written with Tailwind; `css` holds only what utilities can't say.
 */
export const tocador: Theme = {
  id: 'tocador',
  meta: {
    name: 'Tocador',
    industries: ['hair salons', 'barbershops', 'nail studios', 'spas and massage', 'brows and lashes', 'makeup artists', 'aesthetics'],
    moods: ['elegant', 'soft', 'refined', 'calm'],
    scheme: 'light',
    fontStyles: ['serif', 'contrast', 'soft'],
    defaultPalette: { ink: '#2a1f24', paper: '#faf5f1', accent: '#a8466b' },
  },
  tailwind: true,
  css: `
.display{font-family:var(--font-display);font-weight:var(--font-display-weight)}
.arch{border-radius:999px 999px 1.75rem 1.75rem}
.arch img{width:100%;height:100%;object-fit:cover}
.glow{background:radial-gradient(60% 50% at 30% 30%,color-mix(in srgb,var(--accent) 35%,var(--paper)),transparent 70%),radial-gradient(55% 45% at 75% 70%,color-mix(in srgb,var(--accent) 22%,var(--paper)),transparent 70%),color-mix(in srgb,var(--accent) 8%,var(--paper))}
.leader{flex:1;min-width:1.5rem;border-bottom:1.5px dotted color-mix(in srgb,var(--ink) 35%,transparent);transform:translateY(-.3em)}
.seal text{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;fill:currentColor}
.gallery img{width:100%;height:100%;object-fit:cover;border-radius:1.25rem}
.signature{position:relative;overflow:hidden;width:9rem;height:14px;background:linear-gradient(currentColor,currentColor) left center/40% 1px no-repeat,linear-gradient(currentColor,currentColor) right center/40% 1px no-repeat}
.signature::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;background:currentColor;transform:translate(-50%,-50%) rotate(45deg)}
@media (prefers-reduced-motion:no-preference){.seal svg{animation:turn 24s linear infinite}@keyframes turn{to{transform:rotate(360deg)}}}
.reveal .rv{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}
.reveal .rv.in{opacity:1;transform:none}
`,
  script: `(()=>{if(!('IntersectionObserver'in window)||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const els=[...document.querySelectorAll('.prices li,.card,.quote,.gallery > *')];els.forEach((el,i)=>{el.classList.add('rv');el.style.transitionDelay=(i%4)*70+'ms'});document.documentElement.classList.add('reveal');const io=new IntersectionObserver((es)=>{for(const e of es)if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}},{rootMargin:'0px 0px -8% 0px'});els.forEach((el)=>io.observe(el))})();`,
  body: ({ content, links, t, logo, photos, map }) => {
    const items = content.services.map((s) => ({ ...s, icon: iconFor(s.name, s.detail) }));
    const heroIcon: IconName = items.find((i) => i.icon !== 'basket')?.icon ?? 'sparkles';
    const place = placeLine(content);
    return html`
<header class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6">
  <span class="display flex min-w-0 items-center gap-3 text-xl [&_.mark]:h-11 [&_.mark]:w-11 [&_.mark]:rounded-full">${logo}<span class="[overflow-wrap:anywhere]">${content.businessName}</span></span>
  <a href="${links.whatsapp}" class="hidden min-h-11 shrink-0 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper md:inline-flex">${icon('calendar', 'icon h-4 w-4')}${content.ctaText}</a>
</header>

<main>
<section class="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-6 md:grid-cols-[1.1fr_.9fr] md:gap-16 md:pb-24 md:pt-10">
  <div>
    ${areaLine(content) ? html`<p class="mb-6 flex items-center gap-2 text-xs font-bold uppercase tracking-[.25em] text-accent">${icon('pin', 'icon h-4 w-4')}${areaLine(content)}</p>` : ''}
    <h1 class="display text-[clamp(2.8rem,8vw,6rem)] leading-[.98] tracking-tight [text-wrap:balance]">${content.headline}</h1>
    <div class="signature my-8 text-accent" aria-hidden="true"></div>
    <p class="max-w-[36ch] text-lg leading-relaxed text-ink/75 md:text-xl">${content.subhead}</p>
    <div class="mt-9 flex flex-wrap gap-3">
      <a href="${links.whatsapp}" class="inline-flex min-h-14 items-center gap-2 rounded-full bg-accent px-7 text-lg font-semibold text-on-accent shadow-lg shadow-accent/25">${icon('chat', 'icon h-5 w-5')}${content.ctaText}</a>
      ${links.instagram ? html`<a href="${links.instagram}" class="inline-flex min-h-14 items-center gap-2 rounded-full border border-ink/20 px-6 font-semibold">${icon('camera', 'icon h-5 w-5')}Instagram</a>` : ''}
    </div>
  </div>
  <div class="relative mx-auto w-full max-w-md">
    <div class="arch aspect-[4/5] overflow-hidden shadow-2xl shadow-ink/15 ${photos.length ? '' : 'glow grid place-items-center text-accent'}">
      ${photos.length ? photos[0] : html`<span aria-hidden="true">${icon(heroIcon, 'icon h-40 w-40 opacity-80 [stroke-width:1.2]')}</span>`}
    </div>
    <a href="${links.whatsapp}" class="seal absolute -bottom-6 -left-4 grid h-32 w-32 place-items-center rounded-full bg-paper text-ink shadow-xl md:-left-10 md:h-36 md:w-36" aria-label="${content.ctaText}">
      <svg viewBox="0 0 120 120" class="absolute inset-0 h-full w-full" aria-hidden="true"><defs><path id="seal-ring" d="M60 60m-44 0a44 44 0 1 1 88 0a44 44 0 1 1-88 0"/></defs><text><textPath href="#seal-ring">WhatsApp · WhatsApp · WhatsApp · </textPath></text></svg>
      <span class="grid h-12 w-12 place-items-center rounded-full bg-accent text-on-accent">${icon('chat', 'icon h-6 w-6')}</span>
    </a>
  </div>
</section>

<section class="border-y border-ink/10 bg-white/50">
  <div class="mx-auto max-w-5xl px-5 py-20 md:py-28">
    <p class="mb-3 text-center text-xs font-bold uppercase tracking-[.3em] text-accent">${content.businessName}</p>
    <h2 class="display mb-14 text-center text-[clamp(2.2rem,5.5vw,3.8rem)] leading-none">${t.services}</h2>
    <ul class="prices grid gap-x-14 gap-y-7 md:grid-cols-2">
      ${items.map((i) => html`<li class="flex gap-4">
        <span class="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full border border-accent/30 text-accent">${icon(i.icon, 'icon h-5 w-5')}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-end gap-3"><strong class="display text-xl leading-snug [overflow-wrap:anywhere]">${i.name}</strong><span class="leader"></span></div>
          ${i.detail ? html`<p class="mt-1 text-ink/65">${i.detail}</p>` : ''}
        </div>
      </li>`)}
    </ul>
    <div class="mt-14 text-center"><a href="${links.whatsapp}" class="inline-flex min-h-14 items-center gap-2 rounded-full bg-ink px-8 text-lg font-semibold text-paper">${icon('calendar', 'icon h-5 w-5')}${content.ctaText}</a></div>
  </div>
</section>

<section class="mx-auto max-w-4xl px-5 py-20 text-center md:py-28">
  <span class="mx-auto mb-6 block w-fit text-accent" aria-hidden="true">${icon('heart', 'icon h-8 w-8')}</span>
  <h2 class="sr-only">${t.about}</h2>
  <p class="quote display text-[clamp(1.5rem,3.4vw,2.4rem)] italic leading-snug [text-wrap:balance]">${content.about}</p>
</section>

${photos.length > 1 ? html`<section class="gallery mx-auto grid max-w-6xl gap-4 px-5 pb-20 sm:grid-cols-2">${photos.slice(1).map((p) => html`<div class="aspect-[4/5] overflow-hidden rounded-[1.25rem]">${p}</div>`)}</section>` : ''}

${content.hours?.length || place ? html`<section class="mx-auto max-w-6xl px-5 pb-20 md:pb-28">
  <div class="grid gap-5 ${map ? 'md:grid-cols-[.9fr_1.1fr]' : 'md:grid-cols-2'}">
    <div class="card flex flex-col gap-8 rounded-[2rem] bg-accent/8 p-8 md:p-10">
      ${content.hours?.length ? html`<div><h3 class="display mb-5 flex items-center gap-3 text-2xl">${icon('clock', 'icon h-6 w-6 text-accent')}${t.hours}</h3>
        <dl class="divide-y divide-ink/10">${content.hours.map((h) => html`<div class="flex justify-between gap-4 py-3"><dt>${h.days}</dt><dd class="m-0 font-semibold [font-variant-numeric:tabular-nums]">${h.time}</dd></div>`)}</dl></div>` : ''}
      ${place ? html`<div><h3 class="display mb-4 flex items-center gap-3 text-2xl">${icon('pin', 'icon h-6 w-6 text-accent')}${t.address}</h3>
        <address class="mb-5 text-lg not-italic">${place}</address>
        ${links.maps ? html`<a href="${links.maps}" class="inline-flex min-h-12 items-center gap-2 rounded-full border border-ink/25 px-5 font-semibold">${icon('navigation', 'icon h-5 w-5')}${t.directions}</a>` : ''}</div>` : ''}
    </div>
    ${map ? html`<div class="card min-h-80 overflow-hidden rounded-[2rem] border border-ink/10">${map}</div>` : ''}
  </div>
</section>` : ''}

<section class="bg-ink text-paper">
  <div class="mx-auto flex max-w-6xl flex-col items-center gap-7 px-5 py-20 text-center">
    <p class="display text-[clamp(2rem,5vw,3.4rem)] leading-tight">${content.businessName}</p>
    <a href="${links.whatsapp}" class="inline-flex min-h-14 items-center gap-2 rounded-full bg-accent px-8 text-lg font-semibold text-on-accent">${icon('chat', 'icon h-5 w-5')}${content.ctaText}</a>
    <nav class="flex flex-wrap justify-center gap-x-7 gap-y-2">
      ${links.instagram ? html`<a href="${links.instagram}" class="inline-flex min-h-11 items-center gap-2">${icon('camera', 'icon h-5 w-5')}Instagram</a>` : ''}
      ${links.facebook ? html`<a href="${links.facebook}" class="inline-flex min-h-11 items-center gap-2">${icon('users', 'icon h-5 w-5')}Facebook</a>` : ''}
      ${links.phone ? html`<a href="${links.phone}" class="inline-flex min-h-11 items-center gap-2">${icon('phone', 'icon h-5 w-5')}${t.contact}</a>` : ''}
      ${links.email ? html`<a href="${links.email}" class="inline-flex min-h-11 items-center gap-2">${icon('mail', 'icon h-5 w-5')}Email</a>` : ''}
    </nav>
  </div>
</section>
</main>

<a href="${links.whatsapp}" class="fixed bottom-4 right-4 z-30 inline-flex min-h-14 items-center gap-2 rounded-full bg-accent px-5 font-semibold text-on-accent shadow-xl shadow-ink/25 md:hidden">${icon('calendar', 'icon h-5 w-5')}WhatsApp</a>
<div class="h-20 md:hidden" aria-hidden="true"></div>`;
  },
};
