/** Pure profile logic (no React, no network) — unit tested in model.test.ts. */
import type { PersonAvatar } from '@/ui/avatar/types';

export type Me = {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  avatar: PersonAvatar;
};

export const NAME_MAX = 80;

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Mirror of the server rule (trimmed, 1..80) so the form can explain before sending. */
export function checkDisplayName(raw: string): NameCheck {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'Name can’t be empty' };
  if (value.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer` };
  return { ok: true, value };
}

/** Avatar upload bound (px): the server re-bounds to 256, so 512 leaves headroom for retina. */
export const AVATAR_MAX_SIDE = 512;

export type SquareCrop = { originX: number; originY: number; side: number; outSide: number };

/**
 * Centered square crop of a w×h image (the shared definition for native and
 * web pickers): `side = min(w, h)` at the centered origin, and `outSide` is that
 * side bounded by `max`. A picker that already honoured a 1:1 crop (w == h)
 * yields origin 0,0 and the full image — a no-op crop.
 */
export function squareCropRect(w: number, h: number, max: number = AVATAR_MAX_SIDE): SquareCrop {
  const side = Math.max(1, Math.floor(Math.min(w, h)));
  return {
    originX: Math.floor((w - side) / 2),
    originY: Math.floor((h - side) / 2),
    side,
    outSide: Math.min(max, side),
  };
}

const SEED_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random seed for a generated look (the server stores any string up to 64 chars). */
export function randomSeed(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += SEED_ALPHABET[Math.floor(random() * SEED_ALPHABET.length)];
  return s;
}

/**
 * Candidate looks for the "Pick a look" grid: `current` first (so the grid
 * always shows what you have), then fresh unique random seeds.
 */
export function candidateSeeds(current: string, count = 6, random: () => number = Math.random): string[] {
  const out = [current];
  while (out.length < count) {
    const s = randomSeed(random);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Name when set, otherwise the email's local part — what the page calls the person. */
export function displayName(me: Pick<Me, 'name' | 'email'>): string {
  return me.name?.trim() || me.email.split('@')[0];
}

/** Friendly text for an upload failure (server messages pass through when useful). */
export function uploadErrorMessage(status: number | string | undefined, message: string | undefined): string {
  if (status === 413) return 'That photo is too large (max 5 MB). Try a smaller one.';
  if (status === 400) return message?.includes('type') ? 'Use a JPEG, PNG or WebP photo.' : 'We couldn’t read that image. Try another one.';
  if (status === 'FETCH_ERROR') return 'Couldn’t reach the server. Check your connection and try again.';
  return message || 'Upload failed. Please try again.';
}

/** A connected app (OAuth grant) as returned by GET /oauth/grants. */
export interface ConnectedApp {
  id: string;
  client_name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}
