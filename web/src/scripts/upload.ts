// Images are resized in the browser before uploading: smaller uploads on mobile data, EXIF (GPS) stripped by the
// re-encode, and no image library needed in the Lambdas. The server still moderates every file.
/** The day's upload limit for this IP (POST /uploads answered 429). */
export class UploadLimitError extends Error {}

interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

async function resize(file: File, maxSide: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  if (type === 'image/jpeg') {
    context.fillStyle = '#fff'; // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), type, 0.85));
}

async function post(slot: PresignedPost, blob: Blob): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', blob); // S3 requires the file to be the last field
  const response = await fetch(slot.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);
}

/** Resolves to the uploadId to send with POST /generate. */
export async function uploadImages(apiUrl: string, logo: File | undefined, photos: File[]): Promise<string> {
  const response = await fetch(`${apiUrl}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ logo: Boolean(logo), photos: photos.length }),
  });
  if (response.status === 429) throw new UploadLimitError();
  if (!response.ok) throw new Error(`uploads: ${response.status}`);
  const slots = (await response.json()) as { uploadId: string; logo?: PresignedPost; photos: PresignedPost[] };
  await Promise.all([
    ...(logo && slots.logo ? [resize(logo, 512, 'image/png').then((blob) => post(slots.logo!, blob))] : []),
    ...photos.map((photo, i) => resize(photo, 1600, 'image/jpeg').then((blob) => post(slots.photos[i]!, blob))),
  ]);
  return slots.uploadId;
}

/** What the owner says each picked photo shows, kept per file so taking one out keeps the others'. */
const captions = new WeakMap<File, string>();

/** The descriptions of the photos picked in `input`, in file order ("" for none). */
export const captionsOf = (input: HTMLInputElement): string[] => [...(input.files ?? [])].map((file) => captions.get(file)?.trim() ?? '');

export interface ThumbStrings {
  remove: string;
  /** Set: each photo gets a description field with this label and placeholder. */
  caption?: { label: string; placeholder: string };
}

/**
 * Thumbnails of the files picked in `input`, each with a button that takes it out of the input (and, for photos,
 * a field for what it shows). Call it again after the input's files change.
 */
export function showThumbs(input: HTMLInputElement, list: HTMLElement, strings: ThumbStrings, onChange?: () => void): void {
  for (const img of list.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  const files = [...(input.files ?? [])];
  list.replaceChildren(
    ...files.map((file, i) => {
      const item = document.createElement('li');
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${strings.remove}: ${file.name}`);
      remove.onclick = () => {
        const transfer = new DataTransfer();
        files.forEach((kept, j) => j !== i && transfer.items.add(kept));
        input.files = transfer.files;
        showThumbs(input, list, strings, onChange);
        onChange?.();
      };
      const frame = document.createElement('div');
      frame.className = 'thumb';
      frame.append(img, remove);
      item.append(frame);
      if (strings.caption) item.append(captionField(strings.caption, captions.get(file) ?? '', (value) => captions.set(file, value)));
      return item;
    }),
  );
}

/** A photo's description field (the form, Mi sitio → Tus fotos). */
export function captionField(strings: { label: string; placeholder: string }, value: string, onInput: (value: string) => void): HTMLInputElement {
  const field = document.createElement('input');
  field.type = 'text';
  field.maxLength = 100;
  field.value = value;
  field.placeholder = strings.placeholder;
  field.setAttribute('aria-label', strings.label);
  field.addEventListener('input', () => onInput(field.value));
  return field;
}
