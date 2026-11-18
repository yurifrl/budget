/** Multi-user identity module: the only import surface for consumers. */
export { requireUser, requireAdmin, requireUserId, rejectUnlessActiveSession } from './middleware';
export { authDisabled, serviceTokenMatches } from './authz';
export type { IdentityUser } from './types';
export { accessPrincipal, cookieSessionUser, apiBaseUrl, oauthResourceUrl, isAllowed, authMiddleware, mountAuthRoutes } from './authz';
export { DEV_EMAIL } from './middleware';
export { issueAccessToken, verifyAccessToken, issueSession, verifySession } from './auth';
export { resolveOrCreateSessionUser } from './store';
export { safeReturnTo } from './return-to';
export {
  provisionUserByEmail,
  createPlaceholderUser,
  linkEmailToPlaceholder,
  renameUnclaimedUser,
  userReferenceColumns,
  EmailLinkError,
} from './store';
export { default as profileRoutes } from './routes';
import { authOperations } from './authz';
import { operations as profileOperations } from './routes';
/** Every user-feature operation (profile + the /auth/me probe), for the catalog. */
export const operations = [...profileOperations, ...authOperations];
export { personAvatarSql, toPersonAvatar } from './avatar';
export type { PersonAvatar, PersonAvatarRow } from './avatar';
export { personPendingSql, personRefSql, toPersonRef } from './person';
export type { PersonRef, PersonRefRow } from './person';
export { configureAuth, authConfig, DEFAULT_AUTH_CONFIG } from './config';
export type { AuthConfig } from './config';
