const { z } = require('zod');
const { TRANSMISSIONS, FUEL_TYPES } = require('../models/tenant/enums');
const { conflict } = require('../platform/errors');
const { refreshVehicleUsage, refreshStorageUsage } = require('../platform/usage');
const { findOr404, can, moduleOn } = require('./common');
const { presentVehicle, presentRental, presentCost, presentFuelLog } = require('./presenters');
const { vehicleTotals, presentTotals } = require('./metrics');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields } = require('./fields');
const { fileInput, discardFiles } = require('./files');

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
  notes: z.string().trim().max(1000)
};

/** `thumbnail` takes an uploaded photo (POST /uploads { kind: 'vehiclePhoto' }), or null to remove it. */
const photoInput = (ctx) => fileInput(ctx, 'vehiclePhoto').nullable();

const VehicleInputSchema = (ctx) =>
  z.strictObject({
    ...VEHICLE_FIELDS,
    // Whether the fields that aren't core are needed comes from the config (see fields.js).
    year: VEHICLE_FIELDS.year.optional(),
    transmission: VEHICLE_FIELDS.transmission.default('AUTOMATIC'),
    fuelType: VEHICLE_FIELDS.fuelType.default('PETROL'),
    secondaryDailyRate: VEHICLE_FIELDS.secondaryDailyRate.optional(),
    depositAmount: VEHICLE_FIELDS.depositAmount.optional(),
    mileage: VEHICLE_FIELDS.mileage.default(0),
    thumbnail: photoInput(ctx).optional(),
    notes: VEHICLE_FIELDS.notes.default(''),
    customFields: customFieldsInput(ctx.config, 'vehicles')
  });

/** RENTED is set by check-in and cleared by a return, never by hand. */
const VehicleUpdateSchema = (ctx) =>
  z
    .strictObject({ ...VEHICLE_FIELDS, thumbnail: photoInput(ctx), status: z.enum(['AVAILABLE', 'MAINTENANCE']) })
    .partial()
    .extend({ customFields: customFieldsInput(ctx.config, 'vehicles', { update: true }) });

/**
 * A vehicle keeps an uploaded photo as `photo`, and its public link as
 * `thumbnail`, which responses and the booking page show.
 */
function withPhoto(ctx, { thumbnail: photo, ...data }) {
  if (photo === undefined) return data;
  return { ...data, photo, thumbnail: photo && ctx.storage.publicUrl(photo) };
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
      return vehicles.map((v) => ({ ...presentVehicle(v), stats: presentTotals(ctx, totals.of(v._id)) }));
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
        ...presentVehicle(vehicle),
        stats: presentTotals(ctx, totals.of(vehicle._id)),
        rentals: rentals && rentals.map((r) => presentRental({ ...r, vehicle }, ctx)),
        costs: costs && costs.map((c) => presentCost({ ...c, vehicle }, ctx)),
        fuelLogs: fuelLogs && fuelLogs.map((f) => presentFuelLog({ ...f, vehicle }))
      };
    },

    /** Refused at the plan's `limits.maxVehicles`. The deposit defaults to `rules.defaultDepositAmount`. */
    async createVehicle(ctx, input) {
      const data = withPhoto(ctx, parseRecord(VehicleInputSchema(ctx), input, ctx.config, 'vehicles'));
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
      if (data.photo) await refreshStorage(ctx);
      await recordAudit(ctx, { action: 'vehicle.created', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Added ${vehicle.plateNumber} (${vehicle.make} ${vehicle.model})` });
      return presentVehicle(vehicle.toObject());
    },

    async updateVehicle(ctx, vehicleId, input) {
      const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle');
      const { customFields, ...changes } = withPhoto(ctx, parseRecord(VehicleUpdateSchema(ctx), input, ctx.config, 'vehicles', { update: true }));
      if (changes.status && vehicle.status === 'RENTED') throw conflict("A rented vehicle's status changes when it's returned");
      if (changes.plateNumber && changes.plateNumber !== vehicle.plateNumber && (await ctx.models.Vehicle.exists({ plateNumber: changes.plateNumber }))) {
        throw plateTaken(changes.plateNumber);
      }

      // A status change only applies if a check-in didn't rent the vehicle out in the meantime.
      const filter = changes.status ? { _id: vehicle._id, status: { $ne: 'RENTED' } } : { _id: vehicle._id };
      const updated = await ctx.models.Vehicle.findOneAndUpdate(filter, updateWithCustomFields(changes, customFields), { returnDocument: 'after' }).lean();
      if (!updated) throw conflict('The vehicle was rented out in the meantime. Reload and try again.');
      if ('photo' in changes && vehicle.photo?.publicId !== changes.photo?.publicId) {
        await discardFiles(ctx, [vehicle.photo], 'vehiclePhoto');
        await refreshStorage(ctx);
      }
      const fields = [
        // A new photo shows as a changed `thumbnail`.
        ...Object.keys(changes).filter((key) => key !== 'photo' && String(changes[key]) !== String(vehicle[key])),
        ...changedCustomFields(vehicle, customFields)
      ];
      if (fields.length) {
        await recordAudit(ctx, { action: 'vehicle.updated', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Updated ${updated.plateNumber}: ${fields.join(', ')}` });
      }
      return presentVehicle(updated);
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
      await ctx.models.Vehicle.deleteOne({ _id: vehicle._id });
      await refreshUsage(ctx);
      if (vehicle.photo) {
        await discardFiles(ctx, [vehicle.photo], 'vehiclePhoto');
        await refreshStorage(ctx);
      }
      await recordAudit(ctx, { action: 'vehicle.deleted', entityType: 'vehicle', entityId: String(vehicle._id), summary: `Deleted ${vehicle.plateNumber}` });
      return { id: String(vehicle._id), deleted: true };
    }
  };
}

module.exports = { createVehicles };
