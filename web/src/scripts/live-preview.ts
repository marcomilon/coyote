// The QR code that opens the chat on the owner's phone, and the preview that follows it: while the page is
// visible it asks GET /me/chat for the current draft, and shows a new one as soon as a change lands.
import { encode } from 'uqr';
import { api } from './jobs';

const SVG = 'http://www.w3.org/2000/svg';

/** A QR code as an SVG element, drawn with the DOM (no markup strings). */
export function qrCode(text: string, label: string): SVGSVGElement {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(SVG, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join(''));
  path.setAttribute('fill', '#1b1712');
  svg.append(background, path);
  return svg;
}

const POLL_MS = 5000;
/** Stops after this long without a change; a reload starts it again. */
const IDLE_LIMIT_MS = 60 * 60 * 1000;

/** Calls `onChange` with each new draft URL. Returns a function that stops following. */
export function followDraft(token: string, current: string, onChange: (draftUrl: string) => void): () => void {
  let last = current;
  let lastChange = Date.now();
  let timer: number | undefined;
  const stop = () => window.clearTimeout(timer);
  const tick = async () => {
    if (Date.now() - lastChange > IDLE_LIMIT_MS) return;
    if (!document.hidden) {
      try {
        // Any `after` keeps the answer small: this page needs the draft, not the messages.
        const { status, body } = await api<{ draftUrl?: string }>(`/me/chat?after=${Date.now()}`, { headers: { authorization: `Bearer ${token}` } });
        if (status === 401 || status === 429) return;
        if (status === 200 && body.draftUrl && body.draftUrl !== last) {
          last = body.draftUrl;
          lastChange = Date.now();
          onChange(last);
        }
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    }
    timer = window.setTimeout(tick, POLL_MS);
  };
  timer = window.setTimeout(tick, POLL_MS);
  return stop;
}
