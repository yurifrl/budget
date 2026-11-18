/**
 * Minimal react-dom surface for `core/ui/portal.web.ts`. The repo ships no
 * @types/react-dom; extend here if another react-dom API is ever needed.
 */
declare module 'react-dom' {
  import type { ReactNode } from 'react';

  export function createPortal(children: ReactNode, container: Element | null): ReactNode;
}
