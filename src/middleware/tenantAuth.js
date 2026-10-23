const { clerkMiddleware, getAuth } = require('@clerk/express');
const { forbidden, unauthenticated, unavailable } = require('../platform/errors');

/**
 * Requires a Clerk session with an active organization: the organization is
 * the tenant. Sets `req.identity` to the caller's Clerk user and organization.
 */
function requireOrgSession(req, res, next) {
  const auth = getAuth(req);
  if (!auth.userId) return next(unauthenticated('Sign in required'));
  if (!auth.orgId) return next(forbidden('Select an organization first'));
  req.identity = { userId: auth.userId, orgId: auth.orgId };
  next();
}

/**
 * First step of the /api/v1 chain. Without Clerk keys every request gets a
 * 503 that says so, as with the platform API.
 */
function createTenantAuth({ secretKey, publishableKey, authorizedParties }) {
  if (!secretKey || !publishableKey) {
    return (req, res, next) =>
      next(unavailable('auth_not_configured', 'Set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY on the backend'));
  }
  return [clerkMiddleware({ secretKey, publishableKey, authorizedParties }), requireOrgSession];
}

module.exports = { createTenantAuth, requireOrgSession };
