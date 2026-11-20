/** Multi-user identity module: the only import surface for consumers. */
export { requireUser, requireAdmin, requireUserId, rejectUnlessActiveSession, requireFirstPartySession } from './middleware';
export { admitSession, admitGrant, resolvePrincipalUser } from './session-gate';
export { passwordChangeRoutes } from './password-routes';
export { adminUsersRoutes } from './admin-users-routes';
export { noStore, originGuard } from './request-guards';
export type { TrustedOrigins } from './request-guards';
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
import { passwordChangeOperations, passwordSignInOperations } from './password-routes';
import { operations as adminUserOperations } from './admin-users-routes';
/** Every user-feature operation (profile, auth probes, password sign-in, admin users), for the catalog. */
export const operations = [
  ...profileOperations,
  ...authOperations,
  ...passwordSignInOperations,
  ...passwordChangeOperations,
  ...adminUserOperations,
];
export { personAvatarSql, toPersonAvatar } from './avatar';
export type { PersonAvatar, PersonAvatarRow } from './avatar';
export { personPendingSql, personRefSql, toPersonRef } from './person';
export type { PersonRef, PersonRefRow } from './person';
export { configureAuth, authConfig, accessConfigured, passwordLoginEnabled, DEFAULT_AUTH_CONFIG } from './config';
export type { AuthConfig } from './config';
