---
name: classic-bold
description: Photo-led small-business websites with a familiar, easy structure and a bold, characterful look. Combines the classic skill's structure and photography with the frontend-design skill's typography, color and details.
license: Adapted in part from Anthropic's frontend-design skill (Apache License 2.0, prompts/frontend-design-LICENSE.txt).
---

This skill guides the creation of small-business websites that are easy to use and impossible to mistake for a template. The structure is familiar, the kind visitors understand in a second: a clear top bar, a hero with a big photo, sections that each do one job. The personality is not: characterful type, a confident palette, and finishing details that belong to this business and no other. Think of a great local shop with a strong brand: you know exactly where the door is, and you remember the sign.

## Design Thinking

Before coding, look at the business and its photos and decide:
- **Personality**: what makes this business itself? Playful, warm, proud, crafty, sharp, elegant? Commit to one clear direction and carry it through every detail.
- **Hero**: pick the composition that suits the business and its main photo: the photo large beside a big headline, a full-bleed photo with the headline over it, a framed or tilted photo on a colored field, or the business name set huge next to the photo. The photo is always big.
- **Signature**: choose one or two memorable touches that fit the trade: a sticker-style badge ("open now", "no appointment needed", a starting price), a hand-drawn underline, a stamp, a bold frame or offset shadow on photos and cards, a highlighted word in the headline.

## Structure

- **Top bar**: the business name or logo on the left, three or four anchor links, and a contact button on the right. On phones, a simple menu.
- **Hero**: the main photo, a big headline, one short line, the main button and a second one if it helps (WhatsApp and call), and one practical detail such as the address or the hours.
- **Sections**: a few clear ones, each with one job: what the business offers (in a grid of cards, each with its own photo where there is one, with prices when the owner gave them), about, practical details (hours, address, payment), and a final call to contact. A simple footer.
- Keep the reading order obvious. Personality lives in how things look, never in where things are.

## Aesthetics Guidelines

- **Photography**: photos carry the page. Use them large and confident, cropped with `object-fit`, framed with the page's style (a thick border, rounded corners, an offset shadow, a slight tilt). Prefer photos over illustrations; small icons and decorative shapes are welcome as accents.
- **Typography**: choose fonts that are beautiful and characterful, never generic (no Inter, Roboto, Arial or system fonts). Pair a distinctive display font, set large and tight, with a refined, readable body font, from Google Fonts.
- **Color & Theme**: commit to a cohesive palette with CSS variables: a calm base and a few confident accents used with intent (buttons, highlights, card stripes, badges). Dominant colors with sharp accents beat timid, evenly spread palettes.
- **Details**: the finish makes it: consistent borders and radii, offset shadows or outlines carried through buttons and cards, small decorative shapes that echo the trade, a subtle texture or pattern in the background only if it stays quiet behind the content.
- **Layout**: a centered container and a clear grid, generous space, aligned edges. A photo or badge may overlap its frame for life, but the grid stays readable.
- **Fit at every width**: grid columns use `minmax(0, 1fr)`, so one long word can't stretch a column and squeeze its neighbor. A big headline must fit its column from phone to wide desktop: size it with `clamp()` against the space it really has, and give a one-word headline the full width rather than a narrow column. Long emails, links and addresses wrap cleanly instead of breaking letter by letter or spilling out.
- **Motion**: a staggered reveal on load, gentle fade-ins as sections scroll into view, and hover states with a little bounce or lift. No tickers or marquees, no custom cursors, nothing that moves while someone reads.
- **Mobile**: sections stack cleanly, the headline stays big but fits, buttons are big enough to tap, and the contact button is always easy to reach.

## Not generic

Avoid the tired defaults: purple gradients on white, three identical icon cards, "Welcome to…" headlines, stock layouts with nothing of the business in them. No two businesses should get the same fonts, palette and signature details. Write short, concrete copy from what the owner said, and finish every detail: spacing, alignment, image crops, button states.
