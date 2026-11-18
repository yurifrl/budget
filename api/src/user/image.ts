/**
 * Avatar upload normalization (Bun.Image — no sharp dependency).
 *
 * Never trust the client's content type: the format is sniffed from magic
 * bytes, then the image is decoded, bounded to {@link AVATAR_SIZE}px on its
 * long side and re-encoded as WebP. Re-encoding also strips EXIF/metadata and
 * any non-image payload smuggled behind a valid header.
 *
 * Cropping: Bun.Image has resize/rotate but no crop primitive, so the square
 * center-crop happens on the client (native picker `allowsEditing` 1:1; a
 * canvas on web — see modules/profile/pickImage). The server keeps the aspect
 * ratio and renderers use `cover`, so even a non-square upload displays as a
 * centered square crop.
 */
import { HttpError } from '../core/validate';

export const AVATAR_SIZE = 256;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Decompression-bomb guard: reject absurd pixel counts before resizing. */
const MAX_PIXELS = 40_000_000;

export type SniffedFormat = 'jpeg' | 'png' | 'webp';

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** Identify jpeg/png/webp from magic bytes; null for anything else. */
export function sniffImageFormat(b: Uint8Array): SniffedFormat | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

export type NormalizedAvatar = { contentType: 'image/webp'; bytes: Uint8Array };

/** Validate + normalize an uploaded photo. Throws HttpError(400/413). */
export async function normalizeAvatar(input: Uint8Array): Promise<NormalizedAvatar> {
  if (input.length === 0) throw new HttpError(400, 'empty image');
  if (input.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'image too large (max 5 MB)');
  if (!sniffImageFormat(input)) throw new HttpError(400, 'unsupported image type (use jpeg, png or webp)');
  try {
    const meta = await new Bun.Image(input).metadata();
    if (meta.width * meta.height > MAX_PIXELS) throw new HttpError(413, 'image dimensions too large');
    const bytes = await new Bun.Image(input)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .bytes();
    return { contentType: 'image/webp', bytes };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'could not decode image');
  }
}
