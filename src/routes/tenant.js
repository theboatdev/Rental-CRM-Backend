const express = require('express');
const { handle } = require('./handle');
const { createTenantDbGetter } = require('../db/tenantDb');
const { isConnected } = require('../db/platform');
const { resolveTenant, loadMember } = require('../middleware/tenantContext');
const { ALL_PERMISSIONS } = require('../platform/rbac/permissions');
const { unavailable } = require('../platform/errors');

/**
 * Tenant API under /api/v1. Every route runs behind the tenant chain:
 * `tenantAuth` (Clerk session with an organization) → database check →
 * `resolveTenant` → `loadMember`. Feature routes add `requireModule` and
 * `requirePermission`, and reach data only through `req.models`.
 *
 * `directory` finds a tenant by Clerk organization (the platform service).
 * Without `platformDb` every request gets a 503 that says MONGODB_URI is missing.
 */
function createTenantRouter({ tenantAuth, platformDb, directory, cacheTtlMs }) {
  const router = express.Router();
  if (!platformDb) {
    router.use((req, res, next) => next(unavailable('database_not_configured', 'Set MONGODB_URI on the backend')));
    return router;
  }

  router.use(
    tenantAuth,
    (req, res, next) =>
      isConnected(platformDb) ? next() : next(unavailable('database_unavailable', "The backend can't reach its database")),
    resolveTenant({ directory, getTenantDb: createTenantDbGetter(platformDb), cacheTtlMs }),
    loadMember
  );

  /** Who the caller is in this tenant, and what they may do. The tenant app hides what isn't in `permissions`. */
  router.get(
    '/me',
    handle((req) => ({
      user: {
        id: String(req.member._id),
        clerkUserId: req.member.clerkUserId,
        name: req.member.name ?? null,
        email: req.member.email
      },
      tenant: req.tenant,
      role: { key: req.role.key, name: req.role.name, system: req.role.system },
      permissions: ALL_PERMISSIONS.filter((permission) => req.permissions.has(permission)),
      configVersion: req.configVersion
    }))
  );

  /** The active config. Express adds an ETag, so a client revalidating with If-None-Match gets a 304. */
  router.get(
    '/config',
    handle((req, res) => {
      res.set('Cache-Control', 'private, no-cache');
      return { version: req.configVersion, config: req.config };
    })
  );

  return router;
}

module.exports = { createTenantRouter };
