/**
 * Native variant: focus = the app returning to the foreground (AppState
 * 'active'), focus lost = background/inactive. There is no NetInfo dependency,
 * so reconnect rides on the same foreground transition (the common case: the
 * phone regains signal while the app is backgrounded or just reopened).
 */

import { setupListeners } from '@reduxjs/toolkit/query';
import { AppState } from 'react-native';

type Dispatch = Parameters<typeof setupListeners>[0];
type Handler = NonNullable<Parameters<typeof setupListeners>[1]>;

export const nativeListeners: Handler = (dispatch, { onFocus, onFocusLost, onOnline }) => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      dispatch(onFocus());
      dispatch(onOnline());
    } else {
      dispatch(onFocusLost());
    }
  });
  return () => sub.remove();
};

export function setupStoreListeners(dispatch: Dispatch): () => void {
  return setupListeners(dispatch, nativeListeners);
}
