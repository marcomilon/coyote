// Images are resized in the browser before uploading: smaller uploads on mobile data, EXIF (GPS) stripped by the
// re-encode, and no image library needed in the Lambdas. The server still moderates every file.
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
  if (!response.ok) throw new Error(`uploads: ${response.status}`);
  const slots = (await response.json()) as { uploadId: string; logo?: PresignedPost; photos: PresignedPost[] };
  await Promise.all([
    ...(logo && slots.logo ? [resize(logo, 512, 'image/png').then((blob) => post(slots.logo!, blob))] : []),
    ...photos.map((photo, i) => resize(photo, 1600, 'image/jpeg').then((blob) => post(slots.photos[i]!, blob))),
  ]);
  return slots.uploadId;
}
