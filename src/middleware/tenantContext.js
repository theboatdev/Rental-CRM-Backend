const { MODULE_KEYS } = require('../platform/config/modules');
const { effectivePermissions, isPermission } = require('../platform/rbac/permissions');
const { forbidden, notFound } = require('../platform/errors');
const { stripFinancialFields } = require('../platform/rbac/financialFields');

/** Runs an async middleware body and hands a rejection to the error handler. */
const asyncMiddleware = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .then(() => next(), next);

/**
 * Binds the request to the caller's tenant, found from their active Clerk
 * organization through `directory.findTenantByClerkOrgId`. Sets `req.tenant`,
 * `req.config` and `req.configVersion` (the active config), and `req.models`:
 * the models of the tenant's own database, the only way handlers reach tenant data.
 *
 * Lookups are cached for `cacheTtlMs`, so a suspension or config publish can
 * take that long to reach the tenant API.
 */
function resolveTenant({ directory, getTenantDb, cacheTtlMs = 60_000, now = Date.now }) {
  const cache = new Map();

  async function lookup(orgId) {
    const hit = cache.get(orgId);
    if (hit && now() - hit.at < cacheTtlMs) return hit.found;
    const found = await directory.findTenantByClerkOrgId(orgId);
    // Misses aren't cached, so a newly provisioned tenant works at once.
    if (found) cache.set(orgId, { at: now(), found });
    else cache.delete(orgId);
    return found;
  }

  return asyncMiddleware(async (req) => {
    const found = await lookup(req.identity.orgId);
    if (!found?.activeConfig) throw forbidden("This organization isn't set up on the platform");
    const { tenant, activeConfig } = found;
    if (tenant.status !== 'active') throw forbidden(`This workspace is ${tenant.status}`);

    req.tenant = { id: tenant.id, name: tenant.name, slug: tenant.slug };
    req.config = activeConfig.config;
    req.configVersion = activeConfig.version;
    req.models = getTenantDb(tenant.dbName).models;
  });
}

/**
 * Loads the caller's member record and role from the tenant DB. Sets
 * `req.member`, `req.role` and `req.permissions`: the role's permissions minus
 * those of modules the config disables, as a Set.
 */
const loadMember = asyncMiddleware(async (req) => {
  const { Member, Role } = req.models;
  const member = await Member.findOne({ clerkUserId: req.identity.userId, status: 'active' }).lean();
  if (!member) throw forbidden("You aren't a member of this workspace");
  const role = await Role.findOne({ key: member.roleKey }).lean();
  if (!role) throw forbidden(`Your role "${member.roleKey}" no longer exists. Ask an owner to assign another one.`);

  req.member = member;
  req.role = role;
  req.permissions = new Set(effectivePermissions(role.permissions, req.config));
});

/** 404 when the tenant's config disables the module, so a disabled feature looks absent. */
function requireModule(moduleKey) {
  if (!MODULE_KEYS.includes(moduleKey)) throw new Error(`Unknown module: ${moduleKey}`);
  return (req, res, next) => (req.config.modules[moduleKey].enabled ? next() : next(notFound('Not found')));
}

/**
 * 403 unless the caller's effective permissions include at least one of
 * `permissions`. The middleware is marked with the permissions it checks, so
 * a test can assert that every tenant route has one.
 */
function requireAnyPermission(...permissions) {
  for (const permission of permissions) {
    if (!isPermission(permission)) throw new Error(`Unknown permission: ${permission}`);
  }
  const middleware = (req, res, next) =>
    permissions.some((permission) => req.permissions.has(permission))
      ? next()
      : next(forbidden(`You don't have the ${permissions.join(' or ')} permission`));
  middleware.requiredPermissions = permissions;
  return middleware;
}

/** 403 unless the caller's effective permissions include `permission`. Mount it after `requireModule`. */
const requirePermission = (permission) => requireAnyPermission(permission);

/**
 * Drops profit and margin fields (FINANCIAL_FIELDS) from every response
 * unless the caller has financials:view, so they can't be read from the
 * network tab. Handlers return those fields under the listed names and
 * don't filter them themselves.
 */
function hideFinancialFields(req, res, next) {
  if (req.permissions.has('financials:view')) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(stripFinancialFields(body));
  next();
}

module.exports = { resolveTenant, loadMember, requireModule, requirePermission, requireAnyPermission, hideFinancialFields };
