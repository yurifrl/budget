/**
 * Client-side mirror of the API's person-avatar contract (server/user/avatar.ts
 * `PersonAvatar`). Every API that returns a person carries this shape; the
 * `<Avatar>` component consumes it. Keep both definitions in sync.
 *
 *  - `seed`: seed of the generated avatar (see generate.ts).
 *  - `image_version`: non-null ⇒ an uploaded photo exists at
 *    `/users/:id/avatar?v=<image_version>`; null ⇒ render the generated avatar.
 */
export type PersonAvatar = {
  seed: string;
  image_version: number | null;
};

/** Minimal person shape `<Avatar>` renders: identity + avatar, optional label. */
export type AvatarPerson = {
  id: string;
  avatar: PersonAvatar;
  /** Used for the accessibility label (name wins over email). */
  name?: string | null;
  email?: string | null;
};
