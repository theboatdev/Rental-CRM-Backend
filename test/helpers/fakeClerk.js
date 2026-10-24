/**
 * Stands in for the Clerk gateway (src/platform/clerk.js), keeping
 * organizations, invitations and membership changes in memory so tests never call Clerk.
 *
 * - An admin email on the fail.test domain fails its first invitation.
 * - `failOnce(key)` fails the next matching call: `org:<slug>`, `invite:<email>`,
 *   `role:<userId>`, `remove:<userId>` or `delete-org:<orgId>`.
 * - `latencyMs` delays every call, to make concurrent requests overlap.
 */
const { clerkRoleFor } = require('../../src/platform/clerk');

const orgIdFor = (slug) => `org_${slug.replace(/-/g, '_')}`;

const FAIL_INVITE_EMAIL = /@(?:[a-z0-9-]+\.)*fail\.test$/i;

// Shaped like Clerk API errors, so clerkErrorMessage and clerkApiError treat them alike.
const clerkError = (longMessage, status = 422) => Object.assign(new Error('Clerk API error'), { status, errors: [{ longMessage }] });

function createFakeClerk({ latencyMs = 0 } = {}) {
  const organizations = new Map(); // slug → { id, name, slug, publicMetadata }
  const invitations = []; // { id, organizationId, emailAddress, role, publicMetadata, status, createdAt }
  const memberRoles = []; // setMemberRole calls
  const removedMembers = []; // removeMember calls
  const deletedOrganizations = []; // deleteOrganization calls
  const userOrganizations = new Map(); // userId → [orgId]
  const memberships = new Map(); // `${orgId}:${userId}` → membership data, as getMembership returns it
  const failNext = new Set();
  const failedInvites = new Set();
  const calls = { createOrganization: 0, createInvitation: 0, getMembership: 0 };
  let nextInvitation = 1;
  const pause = () => new Promise((resolve) => setTimeout(resolve, latencyMs));
  const failIfAsked = (key, error) => {
    if (failNext.delete(key)) throw error;
  };
  const pendingOf = (organizationId) => invitations.filter((i) => i.organizationId === organizationId && i.status === 'pending');
  const present = (i) => ({ id: i.id, emailAddress: i.emailAddress, roleKey: i.publicMetadata.roleKey, createdAt: i.createdAt, expiresAt: null });

  const fake = {
    organizations,
    invitations,
    memberRoles,
    removedMembers,
    deletedOrganizations,
    userOrganizations,
    calls,
    failOnce: (key) => failNext.add(key),
    /** Makes getMembership find a membership, as Clerk would after an invitation is accepted. */
    addMembership: ({ organizationId, userId, email, firstName, lastName, role = 'org:member', roleKey, updatedAt = Date.now() }) =>
      memberships.set(`${organizationId}:${userId}`, {
        role,
        public_metadata: roleKey ? { roleKey } : {},
        organization: { id: organizationId },
        public_user_data: { user_id: userId, identifier: email, first_name: firstName, last_name: lastName },
        updated_at: updatedAt
      }),

    // Like the real gateway, finds an earlier attempt's organization by tenantId. The slug only names the fake's ids.
    async ensureOrganization({ tenantId, name, slug }) {
      await pause();
      failIfAsked(`org:${slug}`, clerkError('Clerk is unavailable (fake)', 503));
      const existing = [...organizations.values()].find((organization) => organization.publicMetadata.tenantId === tenantId);
      if (existing) return existing.id;
      calls.createOrganization += 1;
      const organization = { id: orgIdFor(slug), name, slug, publicMetadata: { tenantId } };
      organizations.set(slug, organization);
      return organization.id;
    },

    async deleteOrganization(organizationId) {
      await pause();
      failIfAsked(`delete-org:${organizationId}`, clerkError('Clerk is unavailable (fake)', 503));
      for (const [slug, organization] of organizations) if (organization.id === organizationId) organizations.delete(slug);
      deletedOrganizations.push(organizationId);
    },

    async ensureOwnerInvitation({ organizationId, emailAddress }) {
      await pause();
      if (FAIL_INVITE_EMAIL.test(emailAddress) && !failedInvites.has(emailAddress)) {
        failedInvites.add(emailAddress);
        throw clerkError('The email address is on the suppression list (fake)');
      }
      if (pendingOf(organizationId).some((i) => i.emailAddress === emailAddress)) return 'already_invited';
      await fake.inviteMember({ organizationId, emailAddress, roleKey: 'owner' });
      return 'invited';
    },

    async listPendingInvitations(organizationId) {
      await pause();
      return pendingOf(organizationId).map(present);
    },

    async inviteMember({ organizationId, emailAddress, roleKey }) {
      await pause();
      failIfAsked(`invite:${emailAddress}`, clerkError('That email address is invalid (fake)'));
      calls.createInvitation += 1;
      const invitation = {
        id: `orginv_${nextInvitation++}`,
        organizationId,
        emailAddress,
        role: clerkRoleFor(roleKey),
        publicMetadata: { roleKey },
        status: 'pending',
        createdAt: new Date()
      };
      invitations.push(invitation);
      return present(invitation);
    },

    async revokeInvitation({ organizationId, invitationId }) {
      await pause();
      const invitation = pendingOf(organizationId).find((i) => i.id === invitationId);
      if (!invitation) throw clerkError('Not found', 404);
      invitation.status = 'revoked';
    },

    async setMemberRole({ organizationId, userId, roleKey }) {
      await pause();
      failIfAsked(`role:${userId}`, clerkError('Clerk is unavailable (fake)', 503));
      memberRoles.push({ organizationId, userId, role: clerkRoleFor(roleKey) });
    },

    async removeMember({ organizationId, userId }) {
      await pause();
      failIfAsked(`remove:${userId}`, clerkError('Clerk is unavailable (fake)', 503));
      removedMembers.push({ organizationId, userId });
    },

    async getMembership({ organizationId, userId }) {
      calls.getMembership += 1;
      return memberships.get(`${organizationId}:${userId}`) ?? null;
    },

    async listUserOrganizationIds(userId) {
      return userOrganizations.get(userId) ?? [];
    }
  };
  return fake;
}

module.exports = { createFakeClerk, orgIdFor };
