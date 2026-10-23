const { createClerkClient } = require('@clerk/express');
const { OWNER_ROLE_KEY } = require('./rbac/permissions');

/** The most useful message in a Clerk API error, for provisioning step errors. */
function clerkErrorMessage(error) {
  const first = error?.errors?.[0];
  return first?.longMessage || first?.message || error?.message || String(error);
}

const isNotFound = (error) => error?.status === 404;

/**
 * The Clerk Backend API calls the platform makes. Every method is idempotent,
 * so a provisioning retry can repeat one that partly succeeded. Tests pass a
 * fake with the same methods.
 */
function createClerkGateway({ secretKey, invitationRedirectUrl }) {
  if (!secretKey) {
    const notConfigured = async () => {
      throw new Error('Set CLERK_SECRET_KEY on the backend');
    };
    return { ensureOrganization: notConfigured, ensureOwnerInvitation: notConfigured, listUserOrganizationIds: notConfigured };
  }
  const clerk = createClerkClient({ secretKey });

  return {
    /**
     * The tenant's organization, created on the first call. A retry finds the
     * one an earlier attempt created by its slug and `publicMetadata.tenantId`.
     */
    async ensureOrganization({ tenantId, name, slug }) {
      const existing = await clerk.organizations.getOrganization({ slug }).catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (existing.publicMetadata?.tenantId !== tenantId) {
          throw new Error(`The Clerk organization slug "${slug}" is already used by another organization`);
        }
        return existing.id;
      }
      // No createdBy, so the super admin doesn't become a member.
      const organization = await clerk.organizations.createOrganization({ name, slug, publicMetadata: { tenantId } });
      return organization.id;
    },

    /**
     * Invites the tenant admin as Owner (Clerk role org:admin), unless they're
     * already a member or have a pending invitation. Clerk copies the
     * invitation's public metadata to the membership, where the webhook reads `roleKey`.
     */
    async ensureOwnerInvitation({ organizationId, emailAddress }) {
      const members = await clerk.organizations.getOrganizationMembershipList({ organizationId, emailAddress: [emailAddress] });
      if (members.data.length > 0) return 'already_member';
      const pending = await clerk.organizations.getOrganizationInvitationList({ organizationId, status: ['pending'], limit: 100 });
      if (pending.data.some((invitation) => invitation.emailAddress.toLowerCase() === emailAddress.toLowerCase())) {
        return 'already_invited';
      }
      await clerk.organizations.createOrganizationInvitation({
        organizationId,
        emailAddress,
        role: 'org:admin',
        publicMetadata: { roleKey: OWNER_ROLE_KEY },
        ...(invitationRedirectUrl ? { redirectUrl: invitationRedirectUrl } : {})
      });
      return 'invited';
    },

    /** Ids of the organizations a user belongs to. */
    async listUserOrganizationIds(userId) {
      const memberships = await clerk.users.getOrganizationMembershipList({ userId, limit: 100 });
      return memberships.data.map((membership) => membership.organization.id);
    }
  };
}

module.exports = { createClerkGateway, clerkErrorMessage };
