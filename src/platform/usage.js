/** Copies a tenant's active member count to `usage.members`, which the admin dashboard shows against `limits.maxUsers`. */
async function refreshMemberUsage({ Tenant, tenantId, Member }) {
  const members = await Member.countDocuments({ status: 'active' });
  await Tenant.updateOne({ _id: tenantId }, { $set: { 'usage.members': members } });
}

/** Copies a tenant's vehicle count to `usage.vehicles`, shown against `limits.maxVehicles`. */
async function refreshVehicleUsage({ Tenant, tenantId, Vehicle }) {
  const vehicles = await Vehicle.countDocuments();
  await Tenant.updateOne({ _id: tenantId }, { $set: { 'usage.vehicles': vehicles } });
}

module.exports = { refreshMemberUsage, refreshVehicleUsage };
