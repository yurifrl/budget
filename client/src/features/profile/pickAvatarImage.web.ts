/**
 * Web photo picker: a hidden file input, then a canvas center-crop to a
 * square (≤512px) (EXIF orientation applied by createImageBitmap) re-encoded
 * as WebP (browsers without WebP encode fall back to PNG — still accepted).
 * expo-image-picker's web path has no crop, so this keeps the upload square.
 */
import { squareCropRect } from '@/profile/model';

export type PickedImage = { blob: Blob };

function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    input.oncancel = () => done(null);
    // Attached to the DOM (hidden): some browsers ignore click() on detached inputs.
    document.body.appendChild(input);
    input.click();
  });
}

async function squareCrop(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { originX, originY, side, outSide } = squareCropRect(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = outSide;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(
    bitmap,
    originX,
    originY,
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode image'))), 'image/webp', 0.9),
  );
}

/** Open the file chooser; null when cancelled. Throws on unreadable images. */
export async function pickAvatarImage(): Promise<PickedImage | null> {
  const file = await chooseFile();
  return file ? { blob: await squareCrop(file) } : null;
}
