/**
 * RTK Query focus/online wiring (web + shared default). Feeds `refetchOnFocus`,
 * `refetchOnReconnect` and `skipPollingIfUnfocused`. The native variant
 * (listeners.native.ts) maps focus to AppState becoming active.
 */

import { setupListeners } from '@reduxjs/toolkit/query';

type Dispatch = Parameters<typeof setupListeners>[0];
type Handler = NonNullable<Parameters<typeof setupListeners>[1]>;

export const webListeners: Handler = (dispatch, { onFocus, onFocusLost, onOnline, onOffline }) => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const visibility = () => dispatch(document.visibilityState === 'hidden' ? onFocusLost() : onFocus());
  const focus = () => dispatch(onFocus());
  const online = () => dispatch(onOnline());
  const offline = () => dispatch(onOffline());
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', focus);
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', focus);
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
};

/** Wire the store's RTK Query focus/online signals; returns the unsubscribe. */
export function setupStoreListeners(dispatch: Dispatch): () => void {
  return setupListeners(dispatch, webListeners);
}
