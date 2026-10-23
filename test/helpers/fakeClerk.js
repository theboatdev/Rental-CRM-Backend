/**
 * Stands in for the Clerk gateway (src/platform/clerk.js), keeping
 * organizations and invitations in memory so tests never call Clerk.
 *
 * - An admin email on the fail.test domain fails its first invitation.
 * - `failOnce('org:<slug>')` fails the next organization call for that slug.
 * - `latencyMs` delays every call, to make concurrent requests overlap.
 */
const orgIdFor = (slug) => `org_${slug.replace(/-/g, '_')}`;

const FAIL_INVITE_EMAIL = /@(?:[a-z0-9-]+\.)*fail\.test$/i;

// Shaped like a Clerk API error, so clerkErrorMessage picks the long message.
const clerkError = (longMessage) => Object.assign(new Error('Clerk API error'), { status: 422, errors: [{ longMessage }] });

function createFakeClerk({ latencyMs = 0 } = {}) {
  const organizations = new Map(); // slug → { id, name, slug, publicMetadata }
  const invitations = [];
  const userOrganizations = new Map(); // userId → [orgId]
  const failNext = new Set();
  const failedInvites = new Set();
  const calls = { createOrganization: 0, createInvitation: 0 };
  const pause = () => new Promise((resolve) => setTimeout(resolve, latencyMs));

  return {
    organizations,
    invitations,
    userOrganizations,
    calls,
    failOnce: (key) => failNext.add(key),

    async ensureOrganization({ tenantId, name, slug }) {
      await pause();
      if (failNext.delete(`org:${slug}`)) throw clerkError('Clerk is unavailable (fake)');
      const existing = organizations.get(slug);
      if (existing) {
        if (existing.publicMetadata.tenantId !== tenantId) throw new Error(`The Clerk organization slug "${slug}" is already used by another organization`);
        return existing.id;
      }
      calls.createOrganization += 1;
      const organization = { id: orgIdFor(slug), name, slug, publicMetadata: { tenantId } };
      organizations.set(slug, organization);
      return organization.id;
    },

    async ensureOwnerInvitation({ organizationId, emailAddress }) {
      await pause();
      if (FAIL_INVITE_EMAIL.test(emailAddress) && !failedInvites.has(emailAddress)) {
        failedInvites.add(emailAddress);
        throw clerkError('The email address is on the suppression list (fake)');
      }
      if (invitations.some((i) => i.organizationId === organizationId && i.emailAddress === emailAddress)) return 'already_invited';
      calls.createInvitation += 1;
      invitations.push({ organizationId, emailAddress, role: 'org:admin', publicMetadata: { roleKey: 'owner' } });
      return 'invited';
    },

    async listUserOrganizationIds(userId) {
      return userOrganizations.get(userId) ?? [];
    }
  };
}

module.exports = { createFakeClerk, orgIdFor };
