# Handoff: ventas314.com landing page v2

## Overview
Redesign of the ventas314.com home page for Latin American small business owners who need an online presence. Goals: fix the broken hero illustration, state the price, show everything included (site, domain, WhatsApp, Google Maps, socials, catalog), add social proof, offer WhatsApp onboarding, and answer objections with an FAQ.

**Target codebase:** the existing landing page in `web/` (Astro). Update it in place.

## About the design files
`design/Ventas314 Landing v2.dc.html` is a **design reference built in HTML**. Open it in a browser to see the look and behavior. Do not copy it into the codebase. Recreate it in `web/` using the project's existing Astro components, layouts, styles, fonts, i18n setup and asset pipeline. Reuse existing components (logo, buttons, awning, marquee, step cards, footer) and restyle them where they already exist, instead of duplicating them.

All inline styles in the reference map to tokens below. Move them into whatever styling approach `web/` already uses (CSS modules, scoped `<style>`, Tailwind, etc.).

## Fidelity
**High-fidelity.** Colors, type, spacing, borders and shadows are final. Copy is final **except** values in `[brackets]` (stats, testimonials, names, phone number) and prices, which are placeholders the business must supply. Keep the brackets out of production; leave a TODO or pull from content/config.

## Screenshots
- `screenshots/00-current-landing-before.png`: current production page, for comparison.
- `screenshots/01…07-desktop.jpg`: v2 section by section (captured at ~920px width, so the hero is stacked; above ~1000px the hero is two columns).

## Page structure (top to bottom)
Content max-width **1200px**, horizontal padding **24px**, centered.

### 1. Awning (decorative, `aria-hidden`)
- Full width, 48px total.
- Top band 28px: vertical stripes, 40px red `#D93425` / 40px cream `#F5E9D6`, 2px bottom border `#1C1714`.
- Scalloped edge 20px below: half-circles of radius 19px hanging from the band, alternating red/cream to continue the stripes, each with a 2px `#1C1714` outline. Period 80px.
- `drop-shadow(0 3px 0 rgba(28,23,20,.18))`.
- If an awning component already exists in `web/`, update it to this look; an SVG or CSS mask is fine.

### 2. Header
- Flex row, space-between, wraps; padding-top 24px.
- Logo (use existing logo asset) + divider (2px left border) + tagline "PONEMOS TU / NEGOCIO ONLINE" (12px, 700, letter-spacing 1.5px).
- Nav, gap 20px, 15px: `Precio` (#precio), `Ejemplos` (#ejemplos), `Mis sitios`, country selector.
- Country selector: México / Colombia / Brasil / Argentina. 2px ink border, radius 6px, bg `#F5E9D6`. Changes currency, prices, TLD and payment methods (see State). Persist the choice (localStorage or URL param); default from geo/Accept-Language if the site already does that.
- Remove the header "Crear mi sitio" button only if it hurts mobile; otherwise keep the existing one.

### 3. Hero
Grid `repeat(auto-fit, minmax(min(100%,460px),1fr))`, gap 56px, padding 56px 0 72px, items centered.

Left column:
- Badge: "3 PREGUNTAS · 5 MINUTOS · SIN SABER DE TECNOLOGÍA". 13px, 700, ls 1.5px, red text, bg `#FFF8EC`, 2px ink border, shadow `3px 3px 0 #1C1714`, padding 6px 12px.
- H1, Bungee, `clamp(44px,7vw,84px)`, line-height 1.05, ls −1px, three block lines:
  - "TU NEGOCIO": ink
  - "EN INTERNET.": `#D93425`
  - "HOY.": `#F2B825` with text-shadow `4px 4px 0 #1C1714`
- Lead, 20px/1.5, max-width 520px: "Tu sitio web, tu dominio y tu negocio en Google Maps. Tus clientes te escriben directo a WhatsApp."
- Buttons (flex, gap 14px, wrap, margin-top 32px):
  - Primary: "CREAR MI SITIO GRATIS", red bg, cream text.
  - Secondary: "VER EJEMPLOS" → #ejemplos, cream bg, ink text.
  - Variant flag `whatsappFirst`: primary becomes "CRÉALO POR WHATSAPP", secondary "CREAR EN LA WEB". Default off.
- Microcopy, 15px 600 `#3A2F28`: "Gratis para empezar · Sin tarjeta · Cancela cuando quieras" (only if true for the business).

Right column: **phone mockup with one example site** (replaces the old overlapping stacked cards, which rendered both examples on top of each other):
- Phone: 290px wide, bg ink, radius 40px, padding 12px, `rotate(2deg)`, shadow `10px 10px 0 rgba(28,23,20,.25)`.
- Screen: radius 30px, min-height 520px, bg = example color. Contents: notch bar, 150px photo slot (radius 14px), italic tagline in yellow, name in Bungee 28px, 3 service lines with yellow ★, 📍 city, yellow pill CTA (Bungee 14px).
- Below the phone: pill tabs **Taller / Panadería / Salón** switch the example. Active tab = ink bg, cream text.
- Examples:
  - Taller: bg `#8E2A2E`, "Mecánicos desde 1985", TALLER RUIZ, FRENOS Y SUSPENSIÓN / CAMBIO DE ACEITE / DIAGNÓSTICO, Guadalajara, "AGENDA POR WHATSAPP"
  - Panadería: bg `#B8562B`, "Horneado cada mañana", PANADERÍA ROSA, PAN DE MASA MADRE / CROISSANTS / CAFÉ DEL HUILA, Medellín, "PIDE POR WHATSAPP"
  - Salón: bg `#4A2E7A`, "Belleza en tu barrio", SALÓN LUNA, CORTE Y PEINADO / UÑAS / COLOR, Buenos Aires, "RESERVA POR WHATSAPP"
- Better still: use real screenshots of the generated sites.

### 4. Business-type marquee
- Ink band, padding 16px 0, Bungee 18px, ls 1px, cream text.
- Items: FERRETERÍAS, ESTUDIOS, ACADEMIAS, PANADERÍAS, TALLERES, SALONES, CONSULTORIOS, FONDAS, FLORISTERÍAS, VETERINARIAS, each followed by ✦ cycling red `#D93425` / blue `#7BA4F0` / yellow `#F2B825`. Gap 14px, margin-right 40px.
- Animation: duplicate the list, `translate3d(0→-50%)`, 40s linear infinite, `will-change: transform`. **Must** be disabled under `prefers-reduced-motion: reduce`. Animate transform only, so it stays cheap on low-end Android.
- Optional: link each item to its example.

### 5. "Todo lo que tu negocio necesita en internet"
- Section padding 88px 0 40px.
- H2 Bungee `clamp(32px,4.5vw,48px)`, lh 1.05: "TODO LO QUE TU NEGOCIO / NECESITA EN INTERNET".
- Sub 19px/1.5, max 560px: "No es solo una página. Te dejamos listo para que te encuentren y te escriban."
- Grid `repeat(auto-fit,minmax(min(100%,250px),1fr))`, gap 20px, mt 40px. Card: bg `#F5E9D6`, 2px ink border, shadow `4px 4px 0 #1C1714`, radius 10px, padding 22px, column gap 10px. 44px circle icon (2px ink border, colored bg), title Bungee 18px, body 16px/1.45.

| Icon | Circle bg | Title | Body |
|---|---|---|---|
| 🌐 | #F2B825 | TU SITIO WEB | Diseñado para tu negocio y pensado primero para celular. |
| 🔗 | #F5E9D6 | TU DOMINIO | tunegocio.com o {TLD}, a tu nombre. |
| 💬 | #5BD27A | WHATSAPP | Un botón para que te escriban directo desde el sitio. |
| 📍 | #7BA4F0 | GOOGLE MAPS | Te encuentran cuando buscan lo que vendes cerca. |
| 📷 | #F2B825 | REDES SOCIALES | Tu Instagram y Facebook conectados a tu sitio. |
| 📋 | #F5E9D6 | CATÁLOGO Y HORARIOS | Productos, precios, menú y horario siempre actualizados. |

Emoji are placeholders. Swap them for the project's icon set if it has one.

### 6. "Así de corto" (3 steps)
- Same card style; grid min 280px; **cards are top-aligned** (the old page had them staggered).
- 48px yellow numbered circle (Bungee 22px), title Bungee 20px, body 16px/1.5.
  1. TRES PREGUNTAS: El nombre, qué haces y cómo te contactan. Nada más.
  2. NOSOTROS LO ARMAMOS: Textos, colores y tipografía pensados para tu negocio, no una plantilla genérica.
  3. LO AJUSTAS Y PUBLICAS: Ves tu sitio y pides cambios con tus palabras, desde tu enlace privado.

### 7. Social proof `#ejemplos`
- Heading row (space-between, wraps): H2 "NEGOCIOS COMO EL TUYO / YA ESTÁN EN LÍNEA" (2nd line red). Stats: Bungee 40px blue `#1E4FA3` + 15px 600 label: `[+1.200]` negocios publicados, `[8]` países. **Placeholders. Use real numbers or remove.**
- 3 cards (grid min 260px), bg `#FFF8EC`, same border/shadow. 4:3 screenshot of the real site on top (2px ink bottom border), quote 17px/1.5, then a 44px round avatar + name (15px 700) + business · city (14px `#4A3E35`).
- Testimonials are placeholder text. Get real ones with permission.

### 8. Pricing `#precio`
- H2 "CUÁNTO CUESTA"; sub "Precios en {currency}. Sin contratos."
- 2 cards, grid min 320px, max-width 800px, gap 24px, padding 28px.
  - **PARA EMPEZAR** (cream): "GRATIS" Bungee 48px; Sitio publicado en una dirección ventas314 · Botón de WhatsApp · Cambios ilimitados; outline button "EMPEZAR GRATIS".
  - **NEGOCIO COMPLETO** (blue `#1E4FA3`, cream text, yellow "EL MÁS ELEGIDO" tag): price Bungee 48px yellow + "/ mes"; Todo lo del plan gratis · Tu propio dominio (.com o {TLD}) · Alta en Google Maps · Correo con tu nombre · Soporte por WhatsApp; red button "CREAR MI SITIO".
- "Pagas con:" + pills (14px 700, 2px ink border, radius 999px, bg `#FFF8EC`).
- **Prices are placeholders.** Plan contents must match what the product actually offers.

### 9. WhatsApp band
- Full-width blue `#1E4FA3`, 2px ink top/bottom borders, margin-top 56px; inner padding 64px 0, flex space-between, wraps.
- H2 Bungee `clamp(30px,4vw,44px)`, yellow, text-shadow `3px 3px 0 #1C1714`: "¿TIENES WHATSAPP? YA TIENES LO QUE HACE FALTA."
- Sub 19px cream: "Escríbenos, responde 3 preguntas en el chat y te mandamos el enlace a tu sitio."
- Button "CRÉALO POR WHATSAPP": bg `#5BD27A`, ink text → `https://wa.me/<number>?text=<prefilled Spanish/Portuguese message>`. If WhatsApp onboarding doesn't exist yet, point it at the regular flow and flag it to the team.

### 10. FAQ
- max-width 820px, padding 88px 0. Accordion, one open at a time, first open by default. Item: cream bg, 2px ink border, radius 10px; question button 18px 700 with +/− (Bungee 20px); answer 17px/1.55. Use `<details>`/`<summary>` or an accessible button with `aria-expanded`.
  - ¿Necesito saber de tecnología? → No. Respondes 3 preguntas y nosotros armamos todo. Si quieres un cambio, lo pides con tus palabras.
  - ¿El dominio es mío? → Sí. En el plan Negocio Completo el dominio queda a tu nombre. Si un día te vas, te lo llevas.
  - ¿Voy a aparecer en Google? → Tu sitio se publica listo para buscadores y damos de alta tu negocio en Google Maps con tu dirección, horario y teléfono.
  - ¿Puedo cancelar? → Cuando quieras, sin multas ni contratos.
  - ¿Quién me ayuda si tengo un problema? → Una persona real por WhatsApp, en tu idioma y en tu horario.
- Verify every answer is true for the product before shipping.
- Closing CTA: red "CREAR MI SITIO GRATIS" + "¿Dudas? **Escríbenos por WhatsApp**". Consider FAQPage JSON-LD.

### 11. Footer
- 2px ink top border, padding 36px 0, 15px. Left: © ventas314.com · Soporte por WhatsApp: `[number]` · countries served. Right links: Português, Términos, Privacidad.

## Interactions & state
- `country`: MX | CO | BR | AR (default MX). Drives:

| | Currency label | Pro price (placeholder) | TLD | Payments |
|---|---|---|---|---|
| MX | pesos mexicanos (MXN) | $149 | .mx | Tarjeta, OXXO, Mercado Pago, Transferencia SPEI |
| CO | pesos colombianos (COP) | $29.900 | .co | Tarjeta, Nequi, PSE, Efecty |
| BR | reais (BRL) | R$39 | .com.br | Cartão, PIX, Boleto, Mercado Pago |
| AR | pesos argentinos (ARS) | $9.900 | .com.ar | Tarjeta, Mercado Pago, Rapipago, Transferencia |

  Put this in a config/content file. Use an Astro island (or a small vanilla script) only for the selector; render the default server-side.
- `activeExample`: 0–2, hero tabs.
- `openFaq`: index or none.
- `whatsappFirst`: build-time/config flag for the hero CTA order.
- Buttons hover: `translate(-1px,-1px)`, shadow grows to `5px 5px 0 #1C1714`. Secondary hover bg `#FFF8EC`. Add a visible `:focus-visible` outline (2px ink, offset 2px).
- Links: ink, hover red.
- Brazil: the site already has a Português version. Translate all new copy for the pt route.

## Responsive
Mobile-first; most traffic is low-end Android at 360px.
- All grids use `auto-fit/minmax(min(100%,X),1fr)` so they collapse to one column.
- Hero stacks below ~1000px (text first, phone below).
- Headings use `clamp()`. Body text never below 15px. Tap targets ≥ 44px.
- Check at 360, 390, 768 and 1280px. No horizontal scroll (the marquee wrapper needs `overflow:hidden`).

## Design tokens
Colors
- Ink `#1C1714` · Page bg `#E8DCC6` · Card cream `#F5E9D6` · Paper `#FFF8EC`
- Red `#D93425` · Yellow `#F2B825` · Blue `#1E4FA3` · Light blue `#7BA4F0` · WhatsApp green `#5BD27A`
- Muted text `#3A2F28`, `#4A3E35`
- Example bgs: `#8E2A2E`, `#B8562B`, `#4A2E7A`

Type
- Display: **Bungee** 400 (Google Fonts), uppercase headings and buttons. Keep the existing display font if it is already Bungee-like.
- Body: **Figtree** 400/500/600/700. Swap for the site's existing body font if there is one.
- Scale: 84 (h1 max) / 48 (h2) / 28 / 22 / 20 / 19 / 18 / 17 / 16 / 15 / 14 / 13 / 12.

Shape
- Border: 2px solid ink everywhere.
- Radius: 6 (select), 8 (buttons), 10 (cards), 999 (pills), 40/30 (phone).
- Hard shadows: `3px 3px 0 #1C1714` (badge), `4px 4px 0 #1C1714` (cards, buttons), `10px 10px 0 rgba(28,23,20,.25)` (phone).
- Spacing: 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72, 88.

## Assets needed (not in this bundle)
- Real logo (reuse from `web/`).
- Business photos for the hero phone examples.
- Screenshots of 3 real customer sites, plus avatars, names, quotes and permission.
- Real stats, prices, WhatsApp support number, and the list of countries served.
- Optional icon set to replace emoji.

## Files
- `design/Ventas314 Landing v2.dc.html`: interactive reference (open in a browser; `support.js` must sit next to it).
- `screenshots/`: before and after captures.

## Suggested Claude Code prompt
> Read `design_handoff_landing_v2/README.md` and the screenshots. Update the Astro landing page in `web/` to match v2, reusing the existing components, styles and i18n. Keep everything in `[brackets]` as TODO content in a config file. Make it mobile-first and verify it at 360px.
