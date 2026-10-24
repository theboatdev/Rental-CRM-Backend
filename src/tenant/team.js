const { z } = require('zod');
const { isObjectIdOrHexString } = require('mongoose');
const { OWNER_ROLE_KEY, ROLE_KEY_PATTERN } = require('../platform/rbac/permissions');
const { conflict, invalid, notFound } = require('../platform/errors');
const { zodIssues } = require('../platform/config/path');
const { clerkApiError } = require('../platform/clerk');
const { refreshMemberUsage } = require('../platform/usage');
const { assertCanAssign, assertCanManageHolder } = require('./access');
const { recordAudit, iso } = require('./audit');

/**
 * Team management for the tenant API: members, invitations and role
 * assignments. Each function takes the request context built by
 * routes/tenant.js (`models`, `config`, `orgId`, `tenantId`, the caller's
 * `role` and `actor`).
 *
 * Clerk is the source of truth for who belongs to the organization; the
 * tenant DB owns roles. Changes write the tenant DB first, then Clerk, and
 * undo the DB write if Clerk fails, so the two don't drift apart.
 */

const InviteInputSchema = z.strictObject({
  email: z.email({ error: 'Enter an email address' }).transform((email) => email.toLowerCase()),
  roleKey: z.string().regex(ROLE_KEY_PATTERN, { error: 'Pick a role' })
});

const MEMBER_FILTERS = { active: { status: 'active' }, removed: { status: 'removed' }, all: {} };

const presentMember = (m) => ({
  id: String(m._id),
  clerkUserId: m.clerkUserId,
  name: m.name ?? null,
  email: m.email,
  roleKey: m.roleKey,
  status: m.status,
  joinedAt: iso(m.createdAt),
  removedAt: iso(m.removedAt)
});

const presentInvitation = (i) => ({
  id: i.id,
  email: i.emailAddress,
  roleKey: i.roleKey,
  createdAt: iso(i.createdAt),
  expiresAt: iso(i.expiresAt)
});

const labelOf = (member) => member.name || member.email;

/** Calls Clerk, turning a failure into an API error. */
async function viaClerk(call) {
  try {
    return await call();
  } catch (error) {
    throw clerkApiError(error);
  }
}

function createTeam({ clerk, platformDb }) {
  async function requireActiveMember({ Member }, memberId) {
    const member = isObjectIdOrHexString(memberId) ? await Member.findOne({ _id: memberId, status: 'active' }).lean() : null;
    if (!member) throw notFound('Member not found');
    return member;
  }

  async function requireRole({ Role }, roleKey) {
    const role = typeof roleKey === 'string' ? await Role.findOne({ key: roleKey }).lean() : null;
    if (!role) throw invalid(`There's no "${roleKey}" role`, [{ path: 'roleKey', message: 'Unknown role' }]);
    return role;
  }

  /** A member's current role. One that was deleted counts as a role without permissions. */
  async function roleOf({ Role }, member) {
    return (await Role.findOne({ key: member.roleKey }).lean()) ?? { key: member.roleKey, name: member.roleKey, permissions: [] };
  }

  /**
   * Runs `fn` in a transaction that first bumps one lock document, so changes
   * that could remove the last Owner run one at a time per tenant: a
   * concurrent one hits a write conflict and Mongoose retries it.
   */
  const withOwnerLock = (models, fn) =>
    models.Member.db.transaction(async (session) => {
      await models.Counter.updateOne({ _id: 'lock:owners' }, { $inc: { seq: 1 } }, { upsert: true, session });
      return fn(session);
    });

  /** Inside withOwnerLock: the member as they are now, refusing if they'd be the last Owner to go. */
  async function lockedMember({ Member }, member, session, { losesOwner }) {
    const current = await Member.findOne({ _id: member._id, status: 'active' }).session(session).lean();
    if (!current || current.roleKey !== member.roleKey) throw conflict('This member changed in the meantime. Reload and try again.');
    if (losesOwner && current.roleKey === OWNER_ROLE_KEY) {
      const otherOwners = await Member.countDocuments({ _id: { $ne: current._id }, roleKey: OWNER_ROLE_KEY, status: 'active' }).session(session);
      if (otherOwners === 0) throw conflict('A workspace needs at least one Owner. Make someone else an Owner first.');
    }
    return current;
  }

  const refreshUsage = (ctx) => refreshMemberUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, Member: ctx.models.Member });

  return {
    async listMembers(ctx, { status = 'active' } = {}) {
      if (typeof status !== 'string' || !Object.hasOwn(MEMBER_FILTERS, status)) throw invalid('status must be active, removed or all');
      const members = await ctx.models.Member.find(MEMBER_FILTERS[status]).sort({ createdAt: 1 }).lean();
      return members.map(presentMember);
    },

    async listInvitations(ctx) {
      const pending = await viaClerk(() => clerk.listPendingInvitations(ctx.orgId));
      return pending.map(presentInvitation);
    },

    /**
     * Invites someone by email with a role. Refused when they're already a
     * member or invited, or when active members plus pending invitations
     * would exceed the plan's `limits.maxUsers`.
     */
    async invite(ctx, input) {
      const parsed = InviteInputSchema.safeParse(input);
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const { email, roleKey } = parsed.data;
      const role = await requireRole(ctx.models, roleKey);
      assertCanAssign(ctx, role);

      if (await ctx.models.Member.exists({ email, status: 'active' })) throw conflict(`${email} is already a member`);
      const pending = await viaClerk(() => clerk.listPendingInvitations(ctx.orgId));
      if (pending.some((i) => i.emailAddress.toLowerCase() === email)) throw conflict(`${email} already has a pending invitation`);
      const { maxUsers } = ctx.config.limits;
      const active = await ctx.models.Member.countDocuments({ status: 'active' });
      if (active + pending.length >= maxUsers) {
        throw conflict(`Your plan allows ${maxUsers} users, counting pending invitations. Remove a member or revoke an invitation first.`);
      }

      const invitation = await viaClerk(() => clerk.inviteMember({ organizationId: ctx.orgId, emailAddress: email, roleKey: role.key }));
      await recordAudit(ctx, { action: 'member.invited', entityType: 'invitation', entityId: invitation.id, summary: `Invited ${email} as ${role.name}` });
      return presentInvitation(invitation);
    },

    async revokeInvitation(ctx, invitationId) {
      const pending = await viaClerk(() => clerk.listPendingInvitations(ctx.orgId));
      const invitation = pending.find((i) => i.id === invitationId);
      if (!invitation) throw notFound('Invitation not found');
      const role = invitation.roleKey && (await ctx.models.Role.findOne({ key: invitation.roleKey }).lean());
      if (role) assertCanManageHolder(ctx, role);

      await viaClerk(() => clerk.revokeInvitation({ organizationId: ctx.orgId, invitationId }));
      await recordAudit(ctx, { action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId, summary: `Revoked the invitation to ${invitation.emailAddress}` });
      return { id: invitationId, email: invitation.emailAddress, revoked: true };
    },

    async changeRole(ctx, memberId, roleKey) {
      const member = await requireActiveMember(ctx.models, memberId);
      const role = await requireRole(ctx.models, roleKey);
      if (member.roleKey === role.key) return presentMember(member);
      const currentRole = await roleOf(ctx.models, member);
      assertCanManageHolder(ctx, currentRole);
      assertCanAssign(ctx, role);

      await withOwnerLock(ctx.models, async (session) => {
        await lockedMember(ctx.models, member, session, { losesOwner: role.key !== OWNER_ROLE_KEY });
        await ctx.models.Member.updateOne({ _id: member._id }, { $set: { roleKey: role.key } }, { session });
      });
      // Crossing the Owner boundary changes the Clerk role (org:admin ↔ org:member).
      if ((member.roleKey === OWNER_ROLE_KEY) !== (role.key === OWNER_ROLE_KEY)) {
        try {
          await clerk.setMemberRole({ organizationId: ctx.orgId, userId: member.clerkUserId, roleKey: role.key });
        } catch (error) {
          await ctx.models.Member.updateOne({ _id: member._id, roleKey: role.key }, { $set: { roleKey: member.roleKey } });
          throw clerkApiError(error);
        }
      }

      await recordAudit(ctx, {
        action: 'member.role_changed',
        entityType: 'member',
        entityId: String(member._id),
        summary: `Changed ${labelOf(member)} from ${currentRole.name} to ${role.name}`
      });
      return presentMember({ ...member, roleKey: role.key });
    },

    /** Removes a member from the tenant and its Clerk organization. Audit history keeps their name. */
    async removeMember(ctx, memberId) {
      const member = await requireActiveMember(ctx.models, memberId);
      assertCanManageHolder(ctx, await roleOf(ctx.models, member));

      const removedAt = new Date();
      await withOwnerLock(ctx.models, async (session) => {
        await lockedMember(ctx.models, member, session, { losesOwner: true });
        // membershipSyncedAt: a Clerk event from before the removal can't re-activate them.
        await ctx.models.Member.updateOne(
          { _id: member._id },
          { $set: { status: 'removed', removedAt, membershipSyncedAt: removedAt } },
          { session }
        );
      });
      try {
        await clerk.removeMember({ organizationId: ctx.orgId, userId: member.clerkUserId });
      } catch (error) {
        await ctx.models.Member.updateOne(
          { _id: member._id, status: 'removed', removedAt },
          { $set: { status: 'active', membershipSyncedAt: member.membershipSyncedAt ?? null }, $unset: { removedAt: 1 } }
        );
        throw clerkApiError(error);
      }

      await refreshUsage(ctx);
      await recordAudit(ctx, { action: 'member.removed', entityType: 'member', entityId: String(member._id), summary: `Removed ${labelOf(member)}` });
      return presentMember({ ...member, status: 'removed', removedAt });
    }
  };
}

module.exports = { createTeam };
