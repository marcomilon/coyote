/** Requests every Google Fonts URL in the allowlist. A wrong axis or weight returns 400 and no font loads. */
import { FONT_PAIRING_IDS, googleFontsUrl } from '../src/core/fonts';

let failed = 0;
for (const id of FONT_PAIRING_IDS) {
  const response = await fetch(googleFontsUrl(id), { headers: { 'user-agent': 'Mozilla/5.0 Chrome/128' } });
  const css = await response.text();
  const faces = (css.match(/@font-face/g) ?? []).length;
  if (!response.ok || faces === 0) {
    failed++;
    console.log(`✗ ${id}: HTTP ${response.status}`);
  }
}
console.log(failed === 0 ? `all ${FONT_PAIRING_IDS.length} pairings load` : `${failed} pairing(s) failed`);
process.exit(failed === 0 ? 0 : 1);
