const PLATFORM_ROLES = ['super_admin'];

/**
 * Reads the platform role from Clerk session claims. Requires the session
 * token customization `{"metadata": "{{user.public_metadata}}"}` in Clerk.
 */
function getPlatformRole(sessionClaims) {
  const role = sessionClaims?.metadata?.platformRole;
  return PLATFORM_ROLES.includes(role) ? role : null;
}

const isSuperAdmin = (sessionClaims) => getPlatformRole(sessionClaims) === 'super_admin';

module.exports = { PLATFORM_ROLES, getPlatformRole, isSuperAdmin };
