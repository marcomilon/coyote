import { describe, expect, it } from 'vitest';
import { changePhotosInPlace } from '../src/core/photo-slots';

const gallery = `<main><h1>Panadería Luna</h1><div class="gallery"><figure class="shot"><img src="assets/photo-a.jpg" alt="Pan"><figcaption>Pan</figcaption></figure><figure class="shot"><img src="assets/photo-b.jpg" alt="Torta"><figcaption>Torta</figcaption></figure></div>
<section class="hero"><img src="assets/photo-c.jpg" alt=""><p>Desde 1990.</p></section></main>`;
const photos = ['assets/photo-a.jpg', 'assets/photo-b.jpg', 'assets/photo-c.jpg'];

describe('photo changes in place', () => {
  it('takes a photo out of a row of photos, and leaves a photo the page does not show alone', () => {
    const out = changePhotosInPlace(gallery, { added: [], removed: ['assets/photo-a.jpg', 'assets/photo-z.jpg'] }, photos)!;
    expect(out).not.toContain('photo-a.jpg');
    expect(out).not.toContain('<figcaption>Pan</figcaption>');
    expect(out).toContain('<figure class="shot"><img src="assets/photo-b.jpg"');
  });

  it('describes a photo the page shows: alt text and caption', () => {
    const out = changePhotosInPlace(gallery, { added: [], removed: [], described: ['assets/photo-b.jpg'] }, photos, { 'assets/photo-b.jpg': 'Torta de "chocolate"' })!;
    expect(out).toContain('<img src="assets/photo-b.jpg" alt="Torta de &quot;chocolate&quot;"><figcaption>Torta de &quot;chocolate&quot;</figcaption>');
  });

  it('adds new photos after the last one in the row, copied from it', () => {
    const out = changePhotosInPlace(gallery, { added: ['assets/photo-d.jpg', 'assets/photo-e.jpg'], removed: [] }, photos, { 'assets/photo-d.jpg': 'Café' })!;
    expect(out).toContain('<figcaption>Torta</figcaption></figure><figure class="shot"><img src="assets/photo-d.jpg" alt="Café"><figcaption>Café</figcaption></figure><figure class="shot"><img src="assets/photo-e.jpg" alt=""></figure></div>');
  });

  it('needs the page writer when the page has no place for it', () => {
    // The hero photo is on its own: taking it out changes the layout.
    expect(changePhotosInPlace(gallery, { added: [], removed: ['assets/photo-c.jpg'] }, photos)).toBeUndefined();
    // No row of the owner's photos to add to.
    expect(changePhotosInPlace('<main><img src="assets/photo-c.jpg" alt=""></main>', { added: ['assets/photo-d.jpg'], removed: [] }, photos)).toBeUndefined();
    // A description for a photo the page doesn't show: the writer places it.
    expect(changePhotosInPlace(gallery, { added: [], removed: [], described: ['assets/photo-z.jpg'] }, photos, { 'assets/photo-z.jpg': 'Local' })).toBeUndefined();
    // Shown as a CSS background.
    expect(changePhotosInPlace('<main style="background:url(assets/photo-a.jpg)"></main>', { added: [], removed: ['assets/photo-a.jpg'] }, photos)).toBeUndefined();
  });
});
