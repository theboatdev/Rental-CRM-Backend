const { clerkMiddleware, getAuth } = require('@clerk/express');
const { isSuperAdmin } = require('../platform/platformRole');

const deny = (res, status, code, message) => res.status(status).json({ error: { code, message } });

/** Requires a Clerk session whose claims carry the super_admin platform role. Sets `req.actor`. */
function requirePlatformAdmin(req, res, next) {
  const auth = getAuth(req);
  if (!auth.userId) return deny(res, 401, 'unauthenticated', 'Sign in required');
  if (!isSuperAdmin(auth.sessionClaims)) return deny(res, 403, 'forbidden', 'Super admin access required');
  const claims = auth.sessionClaims ?? {};
  req.actor = { id: auth.userId, name: claims.name || claims.email || auth.userId };
  next();
}

/**
 * Middleware chain for /api/platform. Without Clerk keys every request gets a
 * 503 that says so, instead of the server failing to start.
 */
function createPlatformAuth({ secretKey, publishableKey, authorizedParties }) {
  if (!secretKey || !publishableKey) {
    return (req, res) => deny(res, 503, 'auth_not_configured', 'Set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY on the backend');
  }
  return [clerkMiddleware({ secretKey, publishableKey, authorizedParties }), requirePlatformAdmin];
}

module.exports = { createPlatformAuth, requirePlatformAdmin };
