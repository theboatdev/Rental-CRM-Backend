const {
  PERMISSIONS,
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  CustomRoleInputSchema,
  CustomRoleUpdateSchema,
  availablePermissions,
  isPermission
} = require('../platform/rbac/permissions');
const { conflict, invalid, notFound } = require('../platform/errors');
const { zodIssues } = require('../platform/config/path');
const { clerkApiError } = require('../platform/clerk');
const { assertCanDefine } = require('./access');
const { recordAudit } = require('./audit');

/**
 * Roles for the tenant API: the four system roles (read-only) and the
 * tenant's custom roles. Each function takes the request context built by
 * routes/tenant.js.
 */

const SYSTEM_ORDER = SYSTEM_ROLES.map((role) => role.key);

const presentRole = (role, memberCount = 0) => ({
  key: role.key,
  name: role.name,
  description: role.description ?? '',
  permissions: role.permissions.filter(isPermission),
  system: role.system,
  memberCount
});

/** "added a, b; removed c" for the audit log. */
function permissionChanges(before, after) {
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  return [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join('; ');
}

function createRoles({ clerk }) {
  async function requireCustomRole({ Role }, key) {
    const role = await Role.findOne({ key: String(key) }).lean();
    if (!role) throw notFound('Role not found');
    if (role.system) throw invalid("System roles can't be changed or deleted. Create a custom role instead.");
    return role;
  }

  return {
    /** System roles first (Owner, Manager, Staff, Accountant), then custom roles by name, each with its active member count. */
    async listRoles(ctx) {
      const [roles, counts] = await Promise.all([
        ctx.models.Role.find().lean(),
        ctx.models.Member.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$roleKey', count: { $sum: 1 } } }])
      ]);
      const countOf = Object.fromEntries(counts.map(({ _id, count }) => [_id, count]));
      const rank = (role) => (role.system ? SYSTEM_ORDER.indexOf(role.key) : SYSTEM_ORDER.length);
      return roles
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .map((role) => presentRole(role, countOf[role.key] ?? 0));
    },

    /** The permission catalog for the role editor. `available` is false for permissions of modules the config disables. */
    listPermissions(ctx) {
      const available = new Set(availablePermissions(ctx.config));
      return ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSIONS[key], available: available.has(key) }));
    },

    async createRole(ctx, input) {
      const parsed = CustomRoleInputSchema.safeParse(input);
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const data = parsed.data;
      assertCanDefine(ctx, data.permissions);
      const taken = () => conflict(`There's already a role with the key "${data.key}"`);
      if (await ctx.models.Role.exists({ key: data.key })) throw taken();

      let role;
      try {
        role = await ctx.models.Role.create({ ...data, system: false });
      } catch (error) {
        if (error?.code === 11000) throw taken();
        throw error;
      }
      await recordAudit(ctx, { action: 'role.created', entityType: 'role', entityId: data.key, summary: `Created the ${data.name} role` });
      return presentRole(role.toObject());
    },

    async updateRole(ctx, key, input) {
      const role = await requireCustomRole(ctx.models, key);
      const parsed = CustomRoleUpdateSchema.safeParse(input);
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const changes = parsed.data;
      assertCanDefine(ctx, role.permissions);
      if (changes.permissions) assertCanDefine(ctx, changes.permissions);

      const updated = await ctx.models.Role.findOneAndUpdate({ _id: role._id }, { $set: changes }, { returnDocument: 'after' }).lean();
      const summary = [
        changes.name && changes.name !== role.name && `renamed to ${changes.name}`,
        changes.permissions && permissionChanges(role.permissions, changes.permissions)
      ]
        .filter(Boolean)
        .join('; ');
      await recordAudit(ctx, { action: 'role.updated', entityType: 'role', entityId: role.key, summary: `Edited the ${role.name} role${summary ? `: ${summary}` : ''}` });
      const memberCount = await ctx.models.Member.countDocuments({ roleKey: role.key, status: 'active' });
      return presentRole(updated, memberCount);
    },

    /** Refused while active members or pending invitations use the role. */
    async deleteRole(ctx, key) {
      const role = await requireCustomRole(ctx.models, key);
      const members = await ctx.models.Member.countDocuments({ roleKey: role.key, status: 'active' });
      if (members > 0) throw conflict(`${members} member${members === 1 ? ' has' : 's have'} this role. Give them another role first.`);
      let pending;
      try {
        pending = (await clerk.listPendingInvitations(ctx.orgId)).filter((i) => i.roleKey === role.key).length;
      } catch (error) {
        throw clerkApiError(error);
      }
      if (pending > 0) throw conflict(`${pending} pending invitation${pending === 1 ? ' uses' : 's use'} this role. Revoke ${pending === 1 ? 'it' : 'them'} first.`);

      await ctx.models.Role.deleteOne({ _id: role._id });
      await recordAudit(ctx, { action: 'role.deleted', entityType: 'role', entityId: role.key, summary: `Deleted the ${role.name} role` });
      return { key: role.key, deleted: true };
    }
  };
}

module.exports = { createRoles };
