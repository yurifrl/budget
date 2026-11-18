import { Hono } from 'hono';

import { SCOPES, type OAuthConfig } from './config';

/** RFC 9728 protected-resource and RFC 8414 authorization-server metadata. */
export function metadataRoutes(cfg: OAuthConfig): Hono {
  const app = new Hono();

  const resourceDoc = () => ({
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
  });
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceDoc()));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceDoc()));

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
      token_endpoint: `${cfg.issuer}/oauth/token`,
      registration_endpoint: `${cfg.issuer}/oauth/register`,
      revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
      authorization_response_iss_parameter_supported: true,
    }),
  );
  return app;
}
