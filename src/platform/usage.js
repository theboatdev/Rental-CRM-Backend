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

const GB = 1024 ** 3;

const bytesOf = async (Model, project) => (await Model.aggregate([...project, { $group: { _id: null, bytes: { $sum: '$bytes' } } }]))[0]?.bytes ?? 0;

/**
 * Adds up the bytes of a tenant's files (document scans, inspection photos,
 * bills, vehicle photos) into `usage.storageGb`, shown against
 * `limits.storageGb`. Uploads are refused once it reaches the limit.
 */
async function refreshStorageUsage({ Tenant, tenantId, models }) {
  const { Renter, Rental, VehicleCost, Vehicle } = models;
  const photoBytes = (inspection) => ({ $sum: `$${inspection}.photos.file.bytes` });
  const [documents, photos, bills, vehiclePhotos] = await Promise.all([
    bytesOf(Renter, [{ $unwind: '$documents' }, { $project: { bytes: '$documents.file.bytes' } }]),
    bytesOf(Rental, [{ $project: { bytes: { $add: [photoBytes('pickupInspection'), photoBytes('dropInspection')] } } }]),
    bytesOf(VehicleCost, [{ $project: { bytes: '$billFile.bytes' } }]),
    bytesOf(Vehicle, [{ $project: { bytes: '$photo.bytes' } }])
  ]);
  const storageGb = Math.round(((documents + photos + bills + vehiclePhotos) / GB) * 10_000) / 10_000;
  await Tenant.updateOne({ _id: tenantId }, { $set: { 'usage.storageGb': storageGb } });
}

module.exports = { refreshMemberUsage, refreshVehicleUsage, refreshStorageUsage };
