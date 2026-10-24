const { OWNER_ROLE_KEY, isPermission } = require('../platform/rbac/permissions');
const { forbidden } = require('../platform/errors');

/**
 * Guards against privilege escalation in team and role management. Only an
 * Owner can give or take away the Owner role, and nobody can hand out (or act
 * on a member with) permissions they don't hold themselves. An Owner holds
 * every permission, so these only ever stop non-Owners with team:manage or
 * roles:manage in a custom role.
 */

const isOwner = (ctx) => ctx.role.key === OWNER_ROLE_KEY;

/** Permissions in `permissions` that the caller doesn't hold. */
function beyondCaller(ctx, permissions = []) {
  if (isOwner(ctx)) return [];
  const held = new Set(ctx.role.permissions);
  return permissions.filter((permission) => isPermission(permission) && !held.has(permission));
}

/** The caller may give `role` to someone, on an invitation or a role change. */
function assertCanAssign(ctx, role) {
  if (role.key === OWNER_ROLE_KEY && !isOwner(ctx)) throw forbidden('Only an Owner can make someone an Owner');
  const beyond = beyondCaller(ctx, role.permissions);
  if (beyond.length) throw forbidden(`You can't give someone permissions you don't have: ${beyond.join(', ')}`);
}

/** The caller may change the role of, or remove, a member whose role is `role`. */
function assertCanManageHolder(ctx, role) {
  if (role.key === OWNER_ROLE_KEY && !isOwner(ctx)) throw forbidden('Only an Owner can change or remove an Owner');
  const beyond = beyondCaller(ctx, role.permissions);
  if (beyond.length) throw forbidden(`You can't change or remove a member with permissions you don't have: ${beyond.join(', ')}`);
}

/** The caller may create a role with, or edit a role to have, `permissions`. */
function assertCanDefine(ctx, permissions) {
  const beyond = beyondCaller(ctx, permissions);
  if (beyond.length) throw forbidden(`You can't give a role permissions you don't have: ${beyond.join(', ')}`);
}

module.exports = { isOwner, assertCanAssign, assertCanManageHolder, assertCanDefine };
