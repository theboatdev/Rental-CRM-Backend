const { createClerkClient } = require('@clerk/express');
const { OWNER_ROLE_KEY } = require('./rbac/permissions');
const { PlatformError, invalid } = require('./errors');

/** The most useful message in a Clerk API error, for provisioning step errors. */
function clerkErrorMessage(error) {
  const first = error?.errors?.[0];
  return first?.longMessage || first?.message || error?.message || String(error);
}

const isNotFound = (error) => error?.status === 404;

/**
 * A Clerk failure during an API request: Clerk's own message as a 422 when it
 * rejected the input, a 502 when Clerk failed or refused our key.
 */
function clerkApiError(error) {
  if (error instanceof PlatformError) return error;
  const status = error?.status;
  if (status >= 400 && status < 500 && ![401, 403, 429].includes(status)) return invalid(clerkErrorMessage(error));
  console.error('[clerk]', error);
  return new PlatformError(`Clerk didn't complete the request: ${clerkErrorMessage(error)}`, { status: 502, code: 'clerk_unavailable' });
}

/** Clerk only has coarse organization roles: the Owner is org:admin, everyone else org:member. */
const clerkRoleFor = (roleKey) => (roleKey === OWNER_ROLE_KEY ? 'org:admin' : 'org:member');

const presentInvitation = (invitation) => ({
  id: invitation.id,
  emailAddress: invitation.emailAddress,
  roleKey: invitation.publicMetadata?.roleKey ?? null,
  createdAt: new Date(invitation.createdAt),
  expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt) : null
});

/**
 * The Clerk Backend API calls the platform makes. The provisioning methods
 * (`ensure…`) are idempotent, so a retry can repeat one that partly
 * succeeded. Tests pass a fake with the same methods.
 */
function createClerkGateway({ secretKey, invitationRedirectUrl }) {
  const clerk = secretKey ? createClerkClient({ secretKey }) : null;

  const gateway = {
    /**
     * The tenant's organization, created on the first call. A retry finds the
     * one an earlier attempt created by its `publicMetadata.tenantId`.
     *
     * No slug is sent: the tenant's slug lives in the platform DB, and Clerk
     * instances can have organization slugs turned off. No createdBy either,
     * so the super admin doesn't become a member.
     */
    async ensureOrganization({ tenantId, name }) {
      const { data } = await clerk.organizations.getOrganizationList({ query: name, limit: 100 });
      const existing = data.find((organization) => organization.publicMetadata?.tenantId === tenantId);
      if (existing) return existing.id;
      const organization = await clerk.organizations.createOrganization({ name, publicMetadata: { tenantId } });
      return organization.id;
    },

    /** Invites the tenant admin as Owner, unless they're already a member or have a pending invitation. */
    async ensureOwnerInvitation({ organizationId, emailAddress }) {
      const members = await clerk.organizations.getOrganizationMembershipList({ organizationId, emailAddress: [emailAddress] });
      if (members.data.length > 0) return 'already_member';
      const pending = await gateway.listPendingInvitations(organizationId);
      if (pending.some((invitation) => invitation.emailAddress.toLowerCase() === emailAddress.toLowerCase())) {
        return 'already_invited';
      }
      await gateway.inviteMember({ organizationId, emailAddress, roleKey: OWNER_ROLE_KEY });
      return 'invited';
    },

    async listPendingInvitations(organizationId) {
      const { data } = await clerk.organizations.getOrganizationInvitationList({ organizationId, status: ['pending'], limit: 100 });
      return data.map(presentInvitation);
    },

    /**
     * Invites someone with a tenant role. Clerk copies the invitation's public
     * metadata to the membership, where the webhook reads `roleKey`.
     */
    async inviteMember({ organizationId, emailAddress, roleKey }) {
      const invitation = await clerk.organizations.createOrganizationInvitation({
        organizationId,
        emailAddress,
        role: clerkRoleFor(roleKey),
        publicMetadata: { roleKey },
        ...(invitationRedirectUrl ? { redirectUrl: invitationRedirectUrl } : {})
      });
      return presentInvitation(invitation);
    },

    async revokeInvitation({ organizationId, invitationId }) {
      await clerk.organizations.revokeOrganizationInvitation({ organizationId, invitationId });
    },

    /** Sets a member's Clerk organization role to match their tenant role. */
    async setMemberRole({ organizationId, userId, roleKey }) {
      await clerk.organizations.updateOrganizationMembership({ organizationId, userId, role: clerkRoleFor(roleKey) });
    },

    /** Removes a member from the organization. One who is already gone counts as removed. */
    async removeMember({ organizationId, userId }) {
      await clerk.organizations.deleteOrganizationMembership({ organizationId, userId }).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
    },

    /** Ids of the organizations a user belongs to. */
    async listUserOrganizationIds(userId) {
      const memberships = await clerk.users.getOrganizationMembershipList({ userId, limit: 100 });
      return memberships.data.map((membership) => membership.organization.id);
    }
  };

  if (!clerk) {
    const notConfigured = async () => {
      throw new Error('Set CLERK_SECRET_KEY on the backend');
    };
    return Object.fromEntries(Object.keys(gateway).map((method) => [method, notConfigured]));
  }
  return gateway;
}

module.exports = { createClerkGateway, clerkErrorMessage, clerkApiError, clerkRoleFor };
