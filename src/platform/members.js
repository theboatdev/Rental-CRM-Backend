const { OWNER_ROLE_KEY } = require('./rbac/permissions');
const { refreshMemberUsage } = require('./usage');

/** Who the platform audit log credits for changes that come from Clerk webhooks. */
const CLERK_ACTOR = { id: 'clerk', name: 'Clerk webhook' };

/** Role of a member who joined without a usable `roleKey` (e.g. added in the Clerk dashboard) and isn't an org:admin. */
const DEFAULT_MEMBER_ROLE_KEY = 'staff';

const fullName = (first, last) => [first, last].filter(Boolean).join(' ') || null;

/**
 * Keeps each tenant's `members` in step with Clerk, from verified webhook
 * events. Clerk can deliver an event twice or out of order, so every write
 * only applies when the event is newer than the last one applied to that
 * member (`membershipSyncedAt`, `profileSyncedAt`).
 *
 * Roles belong to the tenant: a new member gets the `roleKey` from their
 * invitation (Clerk copies it to the membership), and later Clerk events
 * never change an active member's role.
 */
function createMemberSync({ platformDb, getTenantDb, clerk }) {
  const { Tenant, AuditLog } = platformDb.models;

  async function tenantForOrg(orgId) {
    const tenant = orgId ? await Tenant.findOne({ clerkOrgId: orgId }).lean() : null;
    return tenant && { tenant, models: getTenantDb(tenant.dbName).models };
  }

  const recountMembers = (tenant, Member) => refreshMemberUsage({ Tenant, tenantId: tenant._id, Member });

  /**
   * Applies `update` unless the member's `field` records a newer event. When
   * upserting, a newer document makes the insert hit the unique clerkUserId
   * index: that event is stale and is skipped.
   */
  async function applyIfNewer(Member, clerkUserId, field, at, update, { upsert = false } = {}) {
    const filter = { clerkUserId, $or: [{ [field]: null }, { [field]: { $lte: at } }] };
    try {
      const result = await Member.updateOne(filter, { ...update, $set: { ...update.$set, [field]: at } }, { upsert, runValidators: true });
      return result.matchedCount + result.upsertedCount > 0;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async function roleKeyFor(Role, membership, existing) {
    if (existing?.status === 'active') return existing.roleKey;
    const requested = membership.public_metadata?.roleKey;
    if (requested && (await Role.exists({ key: requested }))) return requested;
    return membership.role === 'org:admin' ? OWNER_ROLE_KEY : DEFAULT_MEMBER_ROLE_KEY;
  }

  async function syncMembership(membership, at) {
    const found = await tenantForOrg(membership.organization?.id);
    if (!found) return false;
    const { Member, Role } = found.models;
    const user = membership.public_user_data ?? {};
    const existing = await Member.findOne({ clerkUserId: user.user_id }).lean();
    const applied = await applyIfNewer(
      Member,
      user.user_id,
      'membershipSyncedAt',
      at,
      {
        $set: {
          email: user.identifier,
          name: fullName(user.first_name, user.last_name),
          roleKey: await roleKeyFor(Role, membership, existing),
          status: 'active'
        },
        $unset: { removedAt: 1 }
      },
      { upsert: true }
    );
    await recountMembers(found.tenant, Member);
    return applied;
  }

  async function removeMembership(membership, at) {
    const found = await tenantForOrg(membership.organization?.id);
    if (!found) return false;
    const { Member } = found.models;
    const user = membership.public_user_data ?? {};
    // Upserts a removed record even for a member we never saw, so a late "created" event can't bring them back.
    const applied = await applyIfNewer(
      Member,
      user.user_id,
      'membershipSyncedAt',
      at,
      {
        $set: { status: 'removed', removedAt: at },
        $setOnInsert: { email: user.identifier, name: fullName(user.first_name, user.last_name), roleKey: DEFAULT_MEMBER_ROLE_KEY }
      },
      { upsert: true }
    );
    await recountMembers(found.tenant, Member);
    return applied;
  }

  /** Copies a user's name and primary email to their member record in every tenant they belong to. */
  async function syncProfile(user, at) {
    const email = user.email_addresses?.find((address) => address.id === user.primary_email_address_id)?.email_address;
    let applied = false;
    for (const orgId of await clerk.listUserOrganizationIds(user.id)) {
      const found = await tenantForOrg(orgId);
      if (!found) continue;
      const update = { $set: { name: fullName(user.first_name, user.last_name), ...(email ? { email } : {}) } };
      applied = (await applyIfNewer(found.models.Member, user.id, 'profileSyncedAt', at, update)) || applied;
    }
    return applied;
  }

  /** Nobody can sign in to a tenant whose organization is gone, so it's suspended until a super admin decides. */
  async function suspendForDeletedOrg(organization) {
    const tenant = await Tenant.findOneAndUpdate({ clerkOrgId: organization.id, status: 'active' }, { $set: { status: 'suspended' } }).lean();
    if (!tenant) return false;
    await AuditLog.create({
      at: new Date(),
      actor: CLERK_ACTOR,
      action: 'tenant.status_changed',
      tenantId: tenant._id,
      tenantName: tenant.name,
      summary: 'Status changed from active to suspended: its Clerk organization was deleted'
    });
    return true;
  }

  /** Applies one verified Clerk webhook event. Resolves to whether it changed anything. */
  function handle(event) {
    const at = new Date(event.timestamp ?? Date.now());
    switch (event.type) {
      case 'organizationMembership.created':
      case 'organizationMembership.updated':
        return syncMembership(event.data, at);
      case 'organizationMembership.deleted':
        return removeMembership(event.data, at);
      case 'user.updated':
        return syncProfile(event.data, at);
      case 'organization.deleted':
        return suspendForDeletedOrg(event.data);
      default:
        // Includes organizationInvitation.accepted: the organizationMembership.created that follows does the work.
        return Promise.resolve(false);
    }
  }

  return { handle };
}

module.exports = { createMemberSync, CLERK_ACTOR, DEFAULT_MEMBER_ROLE_KEY };
