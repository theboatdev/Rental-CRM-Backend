const { isObjectIdOrHexString } = require('mongoose');
const { ALL_PERMISSIONS } = require('./rbac/permissions');
const { conflict, notFound } = require('./errors');
const { createTeam } = require('../tenant/team');
const { createRoles } = require('../tenant/roles');

/** The role a super admin acts with in a tenant: every permission, and Owner-level for the escalation rules. */
const PLATFORM_ADMIN_ROLE = { key: 'platform_admin', name: 'Platform admin', permissions: ALL_PERMISSIONS, system: true };

/**
 * A tenant's users as super admins manage them from the admin dashboard:
 * members, invitations and role assignments. It runs the same rules as the
 * tenant app's Team page (src/tenant/team.js): maxUsers counting pending
 * invitations, last-Owner protection, Clerk kept in step. A super admin acts
 * as an Owner, so they can make or remove Owners.
 *
 * Every change is recorded twice: in the platform audit log, and in the
 * tenant's own log, credited to "<name> (platform admin)" so the tenant sees
 * who changed their team.
 */
function createTenantUsers({ platformDb, getTenantDb, clerk }) {
  const team = createTeam({ clerk, platformDb });
  const roles = createRoles({ clerk });
  const { Tenant, TenantConfig, AuditLog } = platformDb.models;

  /** The tenant and a team context for it. Changes need an active tenant, whose Clerk organization and database exist. */
  async function contextFor(tenantId, actor, { change = false } = {}) {
    const tenant = isObjectIdOrHexString(tenantId) ? await Tenant.findById(tenantId).lean() : null;
    if (!tenant) throw notFound('Tenant not found');
    if (change && tenant.status !== 'active') {
      throw conflict(`${tenant.name} is ${tenant.status}. Users can be added and changed while it's active.`);
    }
    const active = tenant.activeConfigVersion ? await TenantConfig.findOne({ tenantId: tenant._id, version: tenant.activeConfigVersion }).lean() : null;
    const config = active?.config ?? null;
    return {
      tenant,
      ctx: {
        models: getTenantDb(tenant.dbName).models,
        config,
        timezone: config?.locale.timezone ?? 'UTC',
        tenantId: String(tenant._id),
        orgId: tenant.clerkOrgId,
        role: PLATFORM_ADMIN_ROLE,
        platformAdmin: true,
        permissions: new Set(ALL_PERMISSIONS),
        actor: { id: actor.id, name: `${actor.name} (platform admin)` }
      }
    };
  }

  const record = (tenant, actor, action, summary) =>
    AuditLog.create({ at: new Date(), actor: { id: actor.id, name: actor.name }, action, tenantId: tenant._id, tenantName: tenant.name, summary });

  /** Runs a team change for a tenant and records it in the platform audit log. */
  const change = (fn, action, describe) => async (tenantId, actor, ...args) => {
    const { tenant, ctx } = await contextFor(tenantId, actor, { change: true });
    const result = await fn(ctx, ...args);
    await record(tenant, actor, action, describe(result, ...args));
    return result;
  };

  const who = (member) => member.name || member.email;

  return {
    async listMembers(tenantId, actor) {
      const { ctx } = await contextFor(tenantId, actor);
      return team.listMembers(ctx);
    },

    /** Pending invitations; none until provisioning has created the tenant's Clerk organization. */
    async listInvitations(tenantId, actor) {
      const { ctx } = await contextFor(tenantId, actor);
      return ctx.orgId ? team.listInvitations(ctx) : [];
    },

    async listRoles(tenantId, actor) {
      const { ctx } = await contextFor(tenantId, actor);
      return roles.listRoles(ctx);
    },

    invite: change(team.invite, 'member.invited', (invitation) => `Invited ${invitation.email} as ${invitation.roleKey}`),
    changeRole: change(team.changeRole, 'member.role_changed', (member) => `Changed ${who(member)}'s role to ${member.roleKey}`),
    removeMember: change(team.removeMember, 'member.removed', (member) => `Removed ${who(member)}`),
    revokeInvitation: change(team.revokeInvitation, 'invitation.revoked', (revoked) => `Revoked the invitation to ${revoked.email}`)
  };
}

module.exports = { createTenantUsers, PLATFORM_ADMIN_ROLE };
