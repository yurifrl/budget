/**
 * Dispatched when the signed-in identity goes away (sign-out, expired session).
 * The root reducer answers by resetting EVERY slice — RTK Query caches included —
 * so the next user never sees the previous user's cached lists.
 */
import { createAction } from '@reduxjs/toolkit';

export const resetAppState = createAction('app/resetState');
