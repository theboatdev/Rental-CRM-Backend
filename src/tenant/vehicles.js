const { z } = require('zod');
const { TRANSMISSIONS, FUEL_TYPES, VEHICLE_OWNERSHIPS } = require('../models/tenant/enums');
const { conflict, invalid, notFound } = require('../platform/errors');
const { refreshVehicleUsage, refreshStorageUsage } = require('../platform/usage');
const { parse, findOr404, can, moduleOn, activeListKey, IdSchema, DateStringSchema } = require('./common');
const { presentVehicle, presentRental, presentCost, presentFuelLog } = require('./presenters');
const { vehicleTotals, presentTotals } = require('./metrics');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields, customFieldFiles, discardReplacedFieldFiles } = require('./fields');
const { fileInput, discardFiles, discardFieldFiles } = require('./files');

const VEHICLE_FIELDS = {
  plateNumber: z.string().trim().min(2).max(20).transform((plate) => plate.toUpperCase()),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(60),
  year: z.number().int().min(1950).max(2100),
  transmission: z.enum(TRANSMISSIONS),
  fuelType: z.enum(FUEL_TYPES),
  dailyRate: z.number().positive(),
  secondaryDailyRate: z.number().positive().nullable(),
  depositAmount: z.number().min(0),
  mileage: z.number().int().min(0),
  ownership: z.enum(VEHICLE_OWNERSHIPS),
  notes: z.string().trim().max(1000)
};

const rateOnVehicle = (ctx) => ctx.config.modules.vehicles.rateOnVehicle !== false;

/** `thumbnail` takes an uploaded photo (POST /uploads { kind: 'vehiclePhoto' }), or null to remove it. */
const photoInput = (ctx) => fileInput(ctx, 'vehiclePhoto').nullable();

/**
 * One compliance document on a vehicle.  `type` must be an active key from
 * `lists.vehicleDocumentTypes`.  `file` and `expiresAt` are both optional on
 * creation so staff can fill them in later from the dossier.
 */
const VehicleDocumentInputSchema = (ctx) =>
  z.strictObject({
    type: activeListKey(ctx.config, 'vehicleDocumentTypes'),
    expiresAt: DateStringSchema.optional(),
    file: fileInput(ctx, 'vehicleDocument').optional()
  });

const VehicleInputSchema = (ctx) =>
  z.strictObject({
    ...VEHICLE_FIELDS,
    // Whether the fields that aren't core are needed comes from the config (see fields.js).
    year: VEHICLE_FIELDS.year.optional(),
    transmission: VEHICLE_FIELDS.transmission.default('AUTOMATIC'),
    fuelType: VEHICLE_FIELDS.fuelType.default('PETROL'),
    // Required when modules.vehicles.rateOnVehicle is on (enforced in createVehicle).
    dailyRate: VEHICLE_FIELDS.dailyRate.optional(),
    secondaryDailyRate: VEHICLE_FIELDS.secondaryDailyRate.optional(),
    depositAmount: VEHICLE_FIELDS.depositAmount.optional(),
    mileage: VEHICLE_FIELDS.mileage.default(0),
    // Dropped by parseRecord unless modules.vehicles.thirdPartyVehicles is on.
    ownership: VEHICLE_FIELDS.ownership.default('OWNED'),
    // Kept only when third-party tracking and the suppliers module are both on (see applySupplierLink).
    supplierId: IdSchema.nullable().optional(),
    thumbnail: photoInput(ctx).optional(),
    notes: VEHICLE_FIELDS.notes.default(''),
    documents: z.array(VehicleDocumentInputSchema(ctx)).max(20).default([]),
    customFields: customFieldsInput(ctx, 'vehicles')
  });

/** Update the expiry date on an existing document. */
const VehicleDocumentUpdateSchema = z.strictObject({
  expiresAt: DateStringSchema.nullable().optional()
});

/** Signed upload replacement for one vehicle document file. */
const VehicleDocumentFileSchema = (ctx) => z.strictObject({ file: fileInput(ctx, 'vehicleDocument') });

/** RENTED is set by check-in and cleared by a return, never by hand. */
const VehicleUpdateSchema = (ctx) =>
  z
    .strictObject({
      ...VEHICLE_FIELDS,
      supplierId: IdSchema.nullable(),
      thumbnail: photoInput(ctx),
      status: z.enum(['AVAILABLE', 'MAINTENANCE'])
    })
    .partial()
    .extend({ customFields: customFieldsInput(ctx, 'vehicles', { update: true }) });

/**
 * A vehicle keeps an uploaded photo as `photo`, and its public link as
 * `thumbnail`, which responses and the booking page show.
 */
function withPhoto(ctx, { thumbnail: photo, ...data }) {
  if (photo === undefined) return data;
  return { ...data, photo, thumbnail: photo && ctx.storage.publicUrl(photo) };
}

const suppliersLinkOn = (ctx) => moduleOn(ctx, 'suppliers') && Boolean(ctx.config.modules.vehicles.thirdPartyVehicles);

/**
 * Resolves ownership ↔ supplierId. When suppliers + third-party tracking are
 * on, THIRD_PARTY vehicles need a supplier; OWNED clears the link. When those
 * modules are off, supplierId is dropped from the payload.
 */
async function applySupplierLink(ctx, data, { existing } = {}) {
  if (!suppliersLinkOn(ctx)) {
    const { supplierId: _ignored, ...rest } = data;
    return rest;
  }

  // Updates that don't touch ownership/supplier leave the existing link alone.
  const touching = data.ownership !== undefined || data.supplierId !== undefined;
  if (!touching && existing) return data;

  let ownership = data.ownership ?? existing?.ownership ?? 'OWNED';
  if (data.supplierId && ownership !== 'THIRD_PARTY') ownership = 'THIRD_PARTY';

  if (ownership !== 'THIRD_PARTY') {
    return { ...data, ownership, supplierId: null };
  }

  const supplierId =
    data.supplierId !== undefined ? data.supplierId : existing?.supplierId ? String(existing.supplierId) : null;
  if (!supplierId) {
    throw invalid('Pick a supplier for this third-party vehicle', [{ path: 'supplierId', message: 'Required' }]);
  }
  const supplier = await findOr404(ctx.models.Supplier, supplierId, 'Supplier');
  const alreadyLinked = existing?.supplierId && String(existing.supplierId) === String(supplier._id);
  if (supplier.status !== 'ACTIVE' && !alreadyLinked) {
    throw invalid('That supplier is inactive', [{ path: 'supplierId', message: 'Inactive' }]);
  }
  return { ...data, ownership: 'THIRD_PARTY', supplierId: supplier._id };
}

/**
 * The fleet: vehicle records, their status between rentals, and each
 * vehicle's dossier (rental history, service costs, fuel).
 */
function createVehicles({ platformDb }) {
  const refreshUsage = (ctx) => refreshVehicleUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, Vehicle: ctx.models.Vehicle });
  const refreshStorage = (ctx) => refreshStorageUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, models: ctx.models });
  const plateTaken = (plate) => conflict(`Another vehicle already has the plate ${plate}`);

  return {
    /** Every vehicle, by plate, with its lifetime totals. */
    async listVehicles(ctx) {
      const [vehicles, totals] = await Promise.all([ctx.models.Vehicle.find().sort({ plateNumber: 1 }).lean(), vehicleTotals(ctx)]);
      return vehicles.map((v) => ({ ...presentVehicle(v, ctx), stats: presentTotals(ctx, totals.of(v._id)) }));
    },

    /** A vehicle with its totals and the history the caller may read: rentals, service costs, fuel. */
    async getVehicle(ctx, vehicleId) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const { Rental, VehicleCost, FuelLog } = ctx.models;
      const history = (enabled, query) => (enabled ? query.lean() : Promise.resolve(null));
      const [totals, rentals, costs, fuelLogs] = await Promise.all([
        vehicleTotals(ctx),
        history(
          can(ctx, 'rentals:read') && moduleOn(ctx, 'rentals'),
          Rental.find({ vehicle: vehicle._id, status: { $in: ['ACTIVE', 'COMPLETED'] } }).sort({ startDate: -1 }).populate('renter', 'profileId fullName phone')
        ),
        history(can(ctx, 'costs:read') && moduleOn(ctx, 'costs'), VehicleCost.find({ vehicle: vehicle._id }).sort({ incurredAt: -1 })),
        history(can(ctx, 'fuel:read') && moduleOn(ctx, 'fuelLogs'), FuelLog.find({ vehicle: vehicle._id }).sort({ filledAt: -1 }))
      ]);
      return {
        ...presentVehicle(vehicle, ctx),
        stats: presentTotals(ctx, totals.of(vehicle._id)),
        rentals: rentals && rentals.map((r) => presentRental({ ...r, vehicle }, ctx)),
        costs: costs && costs.map((c) => presentCost({ ...c, vehicle }, ctx)),
        fuelLogs: fuelLogs && fuelLogs.map((f) => presentFuelLog({ ...f, vehicle }))
      };
    },

    /** Refused at the plan's `limits.maxVehicles`. The deposit defaults to `rules.defaultDepositAmount`. */
    async createVehicle(ctx, input) {
      const data = await applySupplierLink(ctx, withPhoto(ctx, parseRecord(VehicleInputSchema(ctx), input, ctx.config, 'vehicles')));
      if (rateOnVehicle(ctx) && data.dailyRate == null) {
        throw invalid('Daily rate is required', [{ path: 'dailyRate', message: 'Required' }]);
      }
      const { Vehicle } = ctx.models;
      const { maxVehicles } = ctx.config.limits;
      if ((await Vehicle.countDocuments()) >= maxVehicles) {
        throw conflict(`Your plan allows ${maxVehicles} vehicles. Remove one or ask for a higher limit.`);
      }
      if (await Vehicle.exists({ plateNumber: data.plateNumber })) throw plateTaken(data.plateNumber);

      let vehicle;
      try {
        vehicle = await Vehicle.create({ ...data, depositAmount: data.depositAmount ?? ctx.config.rules.defaultDepositAmount });
      } catch (error) {
        if (error?.code === 11000) throw plateTaken(data.plateNumber);
        throw error;
      }
      await refreshUsage(ctx);
      if (data.photo || data.documents.some((d) => d.file) || customFieldFiles(data.customFields).length) await refreshStorage(ctx);
      await recordAudit(ctx, { action: 'vehicle.created', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Added ${vehicle.plateNumber} (${vehicle.make} ${vehicle.model})` });
      return presentVehicle(vehicle.toObject(), ctx);
    },

    async updateVehicle(ctx, vehicleId, input) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const { customFields, ...parsed } = withPhoto(ctx, parseRecord(VehicleUpdateSchema(ctx), input, ctx.config, 'vehicles', { update: true }));
      const changes = await applySupplierLink(ctx, parsed, { existing: vehicle });
      if (changes.status && vehicle.status === 'RENTED') throw conflict("A rented vehicle's status changes when it's returned");
      if (changes.plateNumber && changes.plateNumber !== vehicle.plateNumber && (await ctx.models.Vehicle.exists({ plateNumber: changes.plateNumber }))) {
        throw plateTaken(changes.plateNumber);
      }

      // A status change only applies if a check-in didn't rent the vehicle out in the meantime.
      const filter = changes.status ? { _id: vehicle._id, status: { $ne: 'RENTED' } } : { _id: vehicle._id };
      const updated = await ctx.models.Vehicle.findOneAndUpdate(filter, updateWithCustomFields(changes, customFields), { returnDocument: 'after' }).lean();
      if (!updated) throw conflict('The vehicle was rented out in the meantime. Reload and try again.');
      const photoChanged = 'photo' in changes && vehicle.photo?.publicId !== changes.photo?.publicId;
      if (photoChanged) await discardFiles(ctx, [vehicle.photo], 'vehiclePhoto');
      const filesChanged = await discardReplacedFieldFiles(ctx, vehicle, customFields);
      if (photoChanged || filesChanged) await refreshStorage(ctx);
      const fields = [
        // A new photo shows as a changed `thumbnail`.
        ...Object.keys(changes).filter((key) => key !== 'photo' && String(changes[key]) !== String(vehicle[key])),
        ...changedCustomFields(vehicle, customFields)
      ];
      if (fields.length) {
        await recordAudit(ctx, { action: 'vehicle.updated', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Updated ${updated.plateNumber}: ${fields.join(', ')}` });
      }
      return presentVehicle(updated, ctx);
    },

    /** Only a vehicle without rentals, costs or fuel logs can be deleted, so history never loses its vehicle. */
    async deleteVehicle(ctx, vehicleId) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const { Rental, VehicleCost, FuelLog } = ctx.models;
      const [rentals, costs, fuelLogs] = await Promise.all(
        [Rental, VehicleCost, FuelLog].map((Model) => Model.exists({ vehicle: vehicle._id }))
      );
      if (rentals || costs || fuelLogs) {
        throw conflict(`${vehicle.plateNumber} has rentals, costs or fuel logs, so it can't be deleted. Set it to maintenance instead.`);
      }
      const documentFiles = (vehicle.documents ?? []).map((d) => d.file).filter(Boolean);
      const fieldFiles = customFieldFiles(vehicle.customFields);
      await ctx.models.Vehicle.deleteOne({ _id: vehicle._id });
      await refreshUsage(ctx);
      if (vehicle.photo || documentFiles.length || fieldFiles.length) {
        await discardFiles(ctx, [vehicle.photo], 'vehiclePhoto');
        await discardFiles(ctx, documentFiles, 'vehicleDocument');
        await discardFieldFiles(ctx, fieldFiles);
        await refreshStorage(ctx);
      }
      await recordAudit(ctx, { action: 'vehicle.deleted', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Deleted ${vehicle.plateNumber}` });
      return { id: String(vehicle._id), deleted: true };
    },

    // -------------------------------------------------------------------------
    // Vehicle document management
    // -------------------------------------------------------------------------

    /** Adds a new compliance document to a vehicle. */
    async addVehicleDocument(ctx, vehicleId, input) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const document = parse(VehicleDocumentInputSchema(ctx), input);
      const updated = await ctx.models.Vehicle.findOneAndUpdate(
        { _id: vehicle._id },
        { $push: { documents: document } },
        { returnDocument: 'after', runValidators: true }
      ).lean();
      if (document.file) await refreshStorage(ctx);
      const scan = document.file ? ' with file' : '';
      await recordAudit(ctx, { action: 'vehicle.document_added', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Added ${document.type} document${scan} to ${vehicle.plateNumber}` });
      return presentVehicle(updated, ctx);
    },

    /** Replaces the file of an existing vehicle document, discarding the old one. */
    async attachVehicleDocumentFile(ctx, vehicleId, documentId, input) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const document = findVehicleDocument(vehicle, documentId);
      const { file } = parse(VehicleDocumentFileSchema(ctx), input);
      const updated = await ctx.models.Vehicle.findOneAndUpdate(
        { _id: vehicle._id, 'documents._id': document._id },
        { $set: { 'documents.$.file': file } },
        { returnDocument: 'after' }
      ).lean();
      await discardFiles(ctx, [document.file], 'vehicleDocument');
      await refreshStorage(ctx);
      await recordAudit(ctx, {
        action: 'vehicle.document_file_attached',
        entityType: 'vehicle',
        entityId: String(vehicle._id),
        summary: `${document.file ? 'Replaced' : 'Attached'} the file of ${vehicle.plateNumber}'s ${document.type}`
      });
      return presentVehicle(updated, ctx);
    },

    /** Updates the expiry date of an existing vehicle document. */
    async updateVehicleDocument(ctx, vehicleId, documentId, input) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const document = findVehicleDocument(vehicle, documentId);
      const changes = parse(VehicleDocumentUpdateSchema, input);
      const $set = {};
      if (changes.expiresAt !== undefined) $set['documents.$.expiresAt'] = changes.expiresAt ? new Date(`${changes.expiresAt}T00:00:00.000Z`) : null;
      const updated = await ctx.models.Vehicle.findOneAndUpdate(
        { _id: vehicle._id, 'documents._id': document._id },
        { $set },
        { returnDocument: 'after' }
      ).lean();
      await recordAudit(ctx, { action: 'vehicle.document_updated', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Updated ${vehicle.plateNumber}'s ${document.type} document` });
      return presentVehicle(updated, ctx);
    }
  };
}

function findVehicleDocument(vehicle, documentId) {
  const { success } = IdSchema.safeParse(documentId);
  const document = success && (vehicle.documents ?? []).find((d) => String(d._id) === documentId);
  if (!document) throw notFound('Document not found');
  return document;
}

module.exports = { createVehicles };
