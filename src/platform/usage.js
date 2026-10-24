/** Copies a tenant's active member count to `usage.members`, which the admin dashboard shows against `limits.maxUsers`. */
async function refreshMemberUsage({ Tenant, tenantId, Member }) {
  const members = await Member.countDocuments({ status: 'active' });
  await Tenant.updateOne({ _id: tenantId }, { $set: { 'usage.members': members } });
}

module.exports = { refreshMemberUsage };
