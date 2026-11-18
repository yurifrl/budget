import { createPortal } from 'react-dom';

/**
 * Real DOM portals on web. Metro resolves this `portal.web.ts` variant on
 * web builds only — react-dom enters the bundle exclusively through here.
 */
export const createPortalOnWeb = createPortal;
