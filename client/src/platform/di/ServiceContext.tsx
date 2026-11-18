/**
 * React bridge for the DI container.
 *
 * The composition root wraps the app in {@link ServiceProvider}. Components call
 * {@link useService} with a token to obtain an injected service. This is the
 * component-side counterpart to the redux thunk `extra` argument used by slices
 * and RTK Query baseQueries.
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { Container , Token } from './container';

const ContainerContext = createContext<Container | null>(null);

export function ServiceProvider({
  container,
  children,
}: {
  container: Container;
  children: ReactNode;
}) {
  return <ContainerContext.Provider value={container}>{children}</ContainerContext.Provider>;
}

/** Access the raw container. Throws if used outside a {@link ServiceProvider}. */
export function useContainer(): Container {
  const c = useContext(ContainerContext);
  if (!c) {
    throw new Error('useContainer must be used within a <ServiceProvider>.');
  }
  return c;
}

/** Resolve a service by token from the nearest {@link ServiceProvider}. */
export function useService<T>(t: Token<T>): T {
  return useContainer().resolve(t);
}
