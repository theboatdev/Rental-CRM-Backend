const { z } = require('zod');
const { parse, findOr404, nextCode, can, moduleOn } = require('./common');
const { presentSupplier, presentVehicle, presentRental } = require('./presenters');
const { recordAudit } = require('./audit');
const { SUPPLIER_STATUSES } = require('../models/tenant/Supplier');

const SUPPLIER_FIELDS = {
  name: z.string().trim().min(2).max(120),
  contactPerson: z.string().trim().max(120).nullable(),
  phone: z.string().trim().min(5).max(30),
  email: z.email().transform((email) => email.toLowerCase()).nullable(),
  bankName: z.string().trim().max(80).nullable(),
  bankAccount: z.string().trim().max(60).nullable(),
  bankAccountHolder: z.string().trim().max(120).nullable(),
  status: z.enum(SUPPLIER_STATUSES),
  notes: z.string().trim().max(1000)
};

const SupplierInputSchema = z.strictObject({
  ...SUPPLIER_FIELDS,
  contactPerson: SUPPLIER_FIELDS.contactPerson.optional(),
  email: SUPPLIER_FIELDS.email.optional(),
  bankName: SUPPLIER_FIELDS.bankName.optional(),
  bankAccount: SUPPLIER_FIELDS.bankAccount.optional(),
  bankAccountHolder: SUPPLIER_FIELDS.bankAccountHolder.optional(),
  status: SUPPLIER_FIELDS.status.default('ACTIVE'),
  notes: SUPPLIER_FIELDS.notes.default('')
});

const SupplierUpdateSchema = z.strictObject(SUPPLIER_FIELDS).partial();

const StatusSchema = z.strictObject({
  status: z.enum(SUPPLIER_STATUSES)
});

/** Rentals that count towards hire history (not reservations or cancellations). */
const COUNTED = { status: { $in: ['ACTIVE', 'COMPLETED'] } };

/**
 * Third-party vehicle supplier profiles. Only reachable when modules.suppliers
 * is on; vehicles link here via supplierId when ownership is THIRD_PARTY.
 */
function createSuppliers() {
  return {
    /** Newest first, each with its number of linked vehicles. */
    async listSuppliers(ctx) {
      const [suppliers, counts] = await Promise.all([
        ctx.models.Supplier.find().sort({ createdAt: -1 }).lean(),
        ctx.models.Vehicle.aggregate([{ $match: { supplierId: { $ne: null } } }, { $group: { _id: '$supplierId', count: { $sum: 1 } } }])
      ]);
      const countOf = new Map(counts.map(({ _id, count }) => [String(_id), count]));
      return suppliers.map((s) => presentSupplier(s, countOf.get(String(s._id)) ?? 0));
    },

    /**
     * Full profile with linked vehicles and hire history (bookings on those
     * vehicles that recorded a supplier rental cost), plus cost totals when
     * the caller may see financials.
     */
    async getSupplier(ctx, supplierId) {
      const supplier = await findOr404(ctx.models.Supplier, supplierId, 'Supplier');
      const vehicles = await ctx.models.Vehicle.find({ supplierId: supplier._id }).sort({ plateNumber: 1 }).lean();
      const vehicleIds = vehicles.map((v) => v._id);

      const showRentals = can(ctx, 'rentals:read') && moduleOn(ctx, 'rentals');
      const rentals = showRentals && vehicleIds.length
        ? await ctx.models.Rental.find({ vehicle: { $in: vehicleIds }, ...COUNTED })
            .sort({ startDate: -1 })
            .populate('vehicle', 'plateNumber make model')
            .populate('renter', 'profileId fullName phone')
            .lean()
        : null;

      const hireHistory = rentals && rentals.map((r) => presentRental(r, ctx));
      const supplierCostsTotal = hireHistory
        ? hireHistory.reduce((sum, r) => sum + (r.supplierRentalCost ?? 0), 0)
        : null;

      return {
        ...presentSupplier(supplier, vehicles.length),
        vehicles: vehicles.map((v) => presentVehicle(v, ctx)),
        hireHistory,
        ...(supplierCostsTotal != null ? { supplierCostsTotal } : {})
      };
    },

    async createSupplier(ctx, input) {
      const data = parse(SupplierInputSchema, input);
      const profileId = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.supplier, sequence: 'supplier' });
      const [supplier] = await ctx.models.Supplier.create([{ ...data, profileId }]);
      await recordAudit(ctx, {
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: String(supplier._id),
        summary: `Registered ${supplier.name} (${supplier.profileId})`
      });
      return presentSupplier(supplier.toObject(), 0);
    },

    async updateSupplier(ctx, supplierId, input) {
      const supplier = await findOr404(ctx.models.Supplier, supplierId, 'Supplier');
      const changes = parse(SupplierUpdateSchema, input);
      const updated = await ctx.models.Supplier.findOneAndUpdate({ _id: supplier._id }, { $set: changes }, { returnDocument: 'after' }).lean();
      const fields = Object.keys(changes).filter((key) => String(changes[key] ?? '') !== String(supplier[key] ?? ''));
      if (fields.length) {
        await recordAudit(ctx, {
          action: 'supplier.updated',
          entityType: 'supplier',
          entityId: String(supplier._id),
          summary: `Updated ${updated.name}: ${fields.join(', ')}`
        });
      }
      const vehicleCount = await ctx.models.Vehicle.countDocuments({ supplierId: supplier._id });
      return presentSupplier(updated, vehicleCount);
    },

    async setStatus(ctx, supplierId, input) {
      const supplier = await findOr404(ctx.models.Supplier, supplierId, 'Supplier');
      const { status } = parse(StatusSchema, input);
      if (status === supplier.status) return presentSupplier(supplier, await ctx.models.Vehicle.countDocuments({ supplierId: supplier._id }));
      const updated = await ctx.models.Supplier.findOneAndUpdate(
        { _id: supplier._id },
        { $set: { status } },
        { returnDocument: 'after' }
      ).lean();
      await recordAudit(ctx, {
        action: 'supplier.status_changed',
        entityType: 'supplier',
        entityId: String(supplier._id),
        summary: `Marked ${updated.name} as ${status === 'ACTIVE' ? 'active' : 'inactive'}`
      });
      const vehicleCount = await ctx.models.Vehicle.countDocuments({ supplierId: supplier._id });
      return presentSupplier(updated, vehicleCount);
    }
  };
}

module.exports = { createSuppliers };
