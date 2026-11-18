import type { ReactNode } from 'react';

/**
 * Web-only portal renderer. Metro resolves `portal.web.ts` (which imports
 * react-dom) on web builds and this native stub everywhere else, so
 * react-dom never enters native bundles.
 *
 * Call sites render through the portal only when this is non-null; on
 * native they fall back to absolutely-positioned in-tree overlays.
 */
export type CreatePortal = (children: ReactNode, container: Element) => ReactNode;

export const createPortalOnWeb: CreatePortal | null = null;
