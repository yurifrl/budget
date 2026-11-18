/**
 * Typed redux hooks for use throughout the app. Use these instead of the
 * untyped `useSelector` / `useDispatch`. `RootState` is the static store's
 * state (type-only import, so no runtime cycle with the features).
 */
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';

import type { AppDispatch, RootState } from './store';

export type { AppDispatch, RootState };

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
