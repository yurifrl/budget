/**
 * Profile routes (post-gate: mounted after requireUser).
 *
 *   GET    /me                → { id, email, name, role, avatar }
 *   PATCH  /me                → { name?, avatar_seed? }  (returns /me)
 *   PUT    /me/avatar         → raw image body (jpeg/png/webp, <= 5 MB)
 *   DELETE /me/avatar         → back to the generated avatar
 *   GET    /users/:id/avatar  → the normalized photo bytes
 *
 * Avatar fetch policy: ANY signed-in user may read ANY user's photo. This is
 * a household app and avatars are not secret; the gate still applies (no
 * anonymous access). Responses are `private` + immutable per `?v=` version.
 */
import { Hono } from 'hono';

import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { HttpError, requireUuidParam } from '../core/validate';
import { meAvatarRemove, meGet, meUpdate } from '@shared/contracts/user';
import { MAX_UPLOAD_BYTES, normalizeAvatar } from './image';
import { forbidOAuthWrites, requireUserId } from './middleware';
import { getAvatarPhoto, getProfile, removeAvatarPhoto, setAvatarPhoto, updateProfile } from './profile-store';

const router = new Hono();

async function meOr404(id: string) {
  const me = await getProfile(id);
  if (!me) throw new HttpError(404, 'user not found');
  return me;
}

/** Declare-once JSON operations (see ./contracts.ts), also exported for the catalog. */
export const operations: readonly AnyOperation[] = [
  implement(meGet, (c) => meOr404(requireUserId(c))),
  implement(meUpdate, async (c, patch) => {
    const me = await updateProfile(requireUserId(c), patch);
    if (!me) throw new HttpError(404, 'user not found');
    return me;
  }),
  implement(meAvatarRemove, async (c) => {
    const id = requireUserId(c);
    await removeAvatarPhoto(id);
    return meOr404(id);
  }),
];
mountOperations(router, operations, { use: [forbidOAuthWrites] });

// Binary endpoints stay hand-written: the operation layer is JSON-only.
router.put('/me/avatar', forbidOAuthWrites, async (c) => {
  const id = requireUserId(c);
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'image too large (max 5 MB)', 'image_too_large');
  const { contentType, bytes } = await normalizeAvatar(new Uint8Array(await c.req.arrayBuffer()));
  await setAvatarPhoto(id, contentType, bytes);
  return c.json(await meOr404(id));
});

router.get('/users/:id/avatar', async (c) => {
  const photo = await getAvatarPhoto(requireUuidParam(c.req.param('id'), 'id'));
  if (!photo) throw new HttpError(404, 'no avatar');
  const etag = `"av${photo.version}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': c.req.query('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    // <img> fetches from the app origin are cross-origin to the API.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(photo.bytes), { headers: { ...headers, 'Content-Type': photo.contentType } });
});

export default router;
