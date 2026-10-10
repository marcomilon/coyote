---
name: classic
description: Classic, photo-led websites in the style of the best website-builder templates. Use for small-business sites that should look polished, familiar and trustworthy.
---

This skill guides the creation of classic, professional websites, the kind the best website-builder templates are made of: one strong photo carrying the page, a familiar structure, calm color, and careful typography. A visitor should understand in a second what the business is, see it at its best, and know how to get in touch. Familiar patterns are the point here; the quality comes from executing them precisely.

## Design Thinking

Before coding, look at the business and its photos and decide:
- **Mood**: warm, fresh, elegant, energetic, homely, premium? Let the trade and the photos decide.
- **Hero pattern**: pick the one that suits the business and its main photo best:
  - a full-bleed photo with the headline set over it
  - a split screen: the photo on one side, the headline and button on a plain field on the other
  - a framed or inset photo on a colored field
  - the business name set very large, over or beside the photo
- **Palette**: a neutral base (white, off-white, cream, or a deep dark) and one accent color taken from the photos or the trade.
- **Type pair**: one display font (an elegant serif or a confident sans) and one readable body font.

## Structure

- **Top bar**: the business name or logo on the left, three or four anchor links, and a contact button on the right. On phones, a simple menu.
- **Hero**: the main photo, a big headline, one short line, and one main button.
- **Sections**: a few clear ones, each with one job: about, services or products in a simple grid, a photo band, practical details (hours, address, payment), and a final call to contact. A simple footer.
- Keep the order easy to follow; visitors should always know where they are and what to do next.

## Aesthetics Guidelines

- **Photography**: photos carry the page. Use them large and confident, cropped with `object-fit`, at most one main photo per section, never shrunk into small thumbnails. No illustrations or clip art; small line icons only where they help.
- **Typography**: fonts from Google Fonts. Large, well-set headlines, two weights at most, generous line height, comfortable line length for reading.
- **Color**: mostly the neutral base, with the accent saved for buttons, links and small highlights. No gradients, neon, glows, noise or grain.
- **Layout**: a centered container, aligned edges, generous white space, and the same spacing rhythm between every section. Whitespace and alignment make it look expensive.
- **Fit at every width**: grid columns use `minmax(0, 1fr)`, so one long word can't stretch a column and squeeze its neighbor. A big headline must fit its column from phone to wide desktop: size it with `clamp()` against the space it really has, and give a one-word headline the full width rather than a narrow column. Long emails, links and addresses wrap cleanly instead of breaking letter by letter or spilling out.
- **Motion**: subtle. A gentle fade-in as sections scroll into view and clear hover states. No tickers or marquees, no parallax tricks, no custom cursors.
- **Mobile**: sections stack cleanly, text stays readable, buttons are big enough to tap, and the contact button is always easy to reach.

## Not generic

Classic is not bland. Avoid the tired defaults: purple gradients, three identical icon cards, "Welcome to…" headlines, stock-looking layouts with nothing of the business in them. Vary the hero pattern, the fonts and the palette from one business to the next, write short concrete copy from what the owner said, and finish every detail: spacing, alignment, image crops, button states.
