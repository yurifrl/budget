/** Pure URL helper for uploaded avatar photos (kept apart from React for tests). */

/**
 * `GET /users/:id/avatar?v=<version>` — the version is the cache-busting key
 * (server: immutable cache lifetime per version), so a changed photo always
 * gets a fresh URL and an unchanged one is served from cache forever.
 */
export function avatarImageUri(apiUrl: string, userId: string, version: number): string {
  return `${apiUrl.replace(/\/+$/, '')}/users/${encodeURIComponent(userId)}/avatar?v=${version}`;
}
