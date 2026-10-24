const express = require('express');
const { handle } = require('./handle');
const { requireDatabase } = require('../middleware/database');
const {
  resolveTenant,
  loadMember,
  requirePermission,
  requireAnyPermission,
  hideFinancialFields
} = require('../middleware/tenantContext');
const { ALL_PERMISSIONS } = require('../platform/rbac/permissions');
const { createTeam } = require('../tenant/team');
const { createRoles } = require('../tenant/roles');
const { listAudit } = require('../tenant/audit');

/** Routes every member may call, so they have no permission check. Every other tenant route must have one (see test/team.test.js). */
const OPEN_ROUTES = ['/me', '/config'];

/** What the team, role and audit functions need from a request. */
const contextOf = (req) => ({
  models: req.models,
  config: req.config,
  tenantId: req.tenant.id,
  orgId: req.identity.orgId,
  role: req.role,
  actor: { id: req.identity.userId, name: req.member.name || req.member.email }
});

/**
 * Tenant API under /api/v1. Every route runs behind the tenant chain:
 * `tenantAuth` (Clerk session with an organization) → database check →
 * `resolveTenant` → `loadMember` → `hideFinancialFields`. Feature routes add
 * `requireModule` and `requirePermission`, and reach data only through `req.models`.
 *
 * `directory` finds a tenant by Clerk organization (the platform service);
 * `clerk` is the Clerk gateway, for invitations and memberships.
 */
function createTenantRouter({ tenantAuth, platformDb, getTenantDb, directory, clerk, cacheTtlMs }) {
  const team = createTeam({ clerk, platformDb });
  const roles = createRoles({ clerk });
  const router = express.Router();
  router.use(
    tenantAuth,
    requireDatabase(platformDb),
    resolveTenant({ directory, getTenantDb, cacheTtlMs }),
    loadMember,
    hideFinancialFields
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

  // Team: members and invitations.
  router.get('/members', requirePermission('team:read'), handle((req) => team.listMembers(contextOf(req), { status: req.query.status })));
  router.patch('/members/:memberId', requirePermission('team:manage'), handle((req) => team.changeRole(contextOf(req), req.params.memberId, req.body?.roleKey)));
  router.delete('/members/:memberId', requirePermission('team:manage'), handle((req) => team.removeMember(contextOf(req), req.params.memberId)));
  router.get('/invitations', requirePermission('team:read'), handle((req) => team.listInvitations(contextOf(req))));
  router.post('/invitations', requirePermission('team:manage'), handle((req) => team.invite(contextOf(req), req.body), 201));
  router.delete('/invitations/:invitationId', requirePermission('team:manage'), handle((req) => team.revokeInvitation(contextOf(req), req.params.invitationId)));

  // Roles. Anyone who sees the team can see the roles and the catalog behind them.
  const rolesRead = requireAnyPermission('team:read', 'roles:manage');
  router.get('/roles', rolesRead, handle((req) => roles.listRoles(contextOf(req))));
  router.get('/permissions', rolesRead, handle((req) => roles.listPermissions(contextOf(req))));
  router.post('/roles', requirePermission('roles:manage'), handle((req) => roles.createRole(contextOf(req), req.body), 201));
  router.patch('/roles/:roleKey', requirePermission('roles:manage'), handle((req) => roles.updateRole(contextOf(req), req.params.roleKey, req.body)));
  router.delete('/roles/:roleKey', requirePermission('roles:manage'), handle((req) => roles.deleteRole(contextOf(req), req.params.roleKey)));

  router.get(
    '/audit',
    requirePermission('audit:read'),
    handle((req) =>
      listAudit(contextOf(req), {
        limit: Math.min(Number(req.query.limit) || 100, 500),
        entityType: typeof req.query.entityType === 'string' ? req.query.entityType : undefined
      })
    )
  );

  return router;
}

module.exports = { createTenantRouter, OPEN_ROUTES };
