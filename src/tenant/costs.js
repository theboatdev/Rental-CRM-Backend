const { z } = require('zod');
const { invalid } = require('../platform/errors');
const { refreshStorageUsage } = require('../platform/usage');
const { parse, findOr404, todayIn, toDate, DateStringSchema, IdSchema, activeListKey } = require('./common');
const { presentCost, presentFuelLog } = require('./presenters');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput } = require('./fields');
const { fileInput, discardFiles } = require('./files');

const CostInputSchema = (ctx, config = ctx.config) =>
  z.strictObject({
    vehicleId: IdSchema,
    category: activeListKey(config, 'costCategories'),
    title: z.string().trim().min(2).max(200),
    amount: z.number().positive(),
    incurredAt: DateStringSchema.optional(),
    serviceCenter: z.string().trim().max(120).optional(),
    invoiceNumber: z.string().trim().max(60).optional(),
    // The scanned bill, uploaded as a `bill` file. Required with modules.costs.requireBillUpload.
    billFile: fileInput(ctx, 'bill').optional(),
    odometer: z.number().int().min(0).optional(),
    notes: z.string().trim().max(1000).default(''),
    customFields: customFieldsInput(config, 'costs')
  });

const AttachBillSchema = (ctx) => z.strictObject({ billFile: fileInput(ctx, 'bill') });

const FuelInputSchema = z
  .strictObject({
    vehicleId: IdSchema,
    liters: z.number().positive().max(500),
    pricePerLiter: z.number().positive().optional(),
    totalCost: z.number().positive().optional(),
    station: z.string().trim().max(120).optional(),
    odometer: z.number().int().min(0).optional(),
    filledAt: DateStringSchema.optional(),
    notes: z.string().trim().max(1000).default('')
  })
  .refine((log) => log.pricePerLiter || log.totalCost, { error: 'Enter the price per liter or the total', path: ['totalCost'] });

const round2 = (value) => Math.round(value * 100) / 100;

const listFor = (Model, dateField) => async (ctx, { vehicleId } = {}) => {
  const filter = IdSchema.safeParse(vehicleId).success ? { vehicle: vehicleId } : {};
  return Model(ctx).find(filter).sort({ [dateField]: -1, createdAt: -1 }).populate('vehicle', 'plateNumber make model').lean();
};

/** A reading above the vehicle's mileage moves the mileage up; it never goes down. */
async function raiseMileage(ctx, vehicleId, odometer) {
  if (odometer != null) await ctx.models.Vehicle.updateOne({ _id: vehicleId }, { $max: { mileage: odometer } });
}

/**
 * Operating costs (service bills, repairs, insurance; categories from
 * `lists.costCategories`) and fuel fill-ups, per vehicle. A cost can carry
 * the scan of its bill.
 */
function createCosts({ platformDb }) {
  const refreshStorage = (ctx) => refreshStorageUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, models: ctx.models });
  const listCostDocs = listFor((ctx) => ctx.models.VehicleCost, 'incurredAt');
  const listFuelDocs = listFor((ctx) => ctx.models.FuelLog, 'filledAt');

  return {
    async listCosts(ctx, query) {
      return (await listCostDocs(ctx, query)).map((c) => presentCost(c, ctx));
    },

    async createCost(ctx, input) {
      const data = parseRecord(CostInputSchema(ctx), input, ctx.config, 'costs');
      if (ctx.config.modules.costs.requireBillUpload && !data.billFile) {
        throw invalid('Attach the scanned bill', [{ path: 'billFile', message: 'Required' }]);
      }
      const vehicle = await findOr404(ctx.models.Vehicle, data.vehicleId, 'Vehicle');
      const { vehicleId, incurredAt, ...fields } = data;
      const cost = await ctx.models.VehicleCost.create({
        ...fields,
        vehicle: vehicle._id,
        incurredAt: toDate(incurredAt ?? todayIn(ctx.timezone)),
        createdBy: ctx.actor
      });
      await raiseMileage(ctx, vehicle._id, data.odometer);
      if (data.billFile) await refreshStorage(ctx);
      await recordAudit(ctx, { action: 'cost.created', entityType: 'cost', entityId: String(cost._id), summary: `Logged ${data.amount} for ${vehicle.plateNumber}: ${data.title}` });
      return presentCost({ ...cost.toObject(), vehicle }, ctx);
    },

    /** Attaches the scanned bill to a cost logged without it, or replaces (and deletes) the one it had. */
    async attachBill(ctx, costId, input) {
      const cost = await findOr404(ctx.models.VehicleCost, costId, 'Cost', { populate: { vehicle: 'plateNumber make model' } });
      const { billFile } = parse(AttachBillSchema(ctx), input);
      await ctx.models.VehicleCost.updateOne({ _id: cost._id }, { $set: { billFile } });
      await discardFiles(ctx, [cost.billFile], 'bill');
      await refreshStorage(ctx);
      await recordAudit(ctx, {
        action: 'cost.bill_attached',
        entityType: 'cost',
        entityId: costId,
        summary: `${cost.billFile ? 'Replaced' : 'Attached'} the bill of "${cost.title}" for ${cost.vehicle?.plateNumber ?? 'a deleted vehicle'}`
      });
      return presentCost({ ...cost, billFile }, ctx);
    },

    /** Deletes the entry and its bill. */
    async deleteCost(ctx, costId) {
      const cost = await findOr404(ctx.models.VehicleCost, costId, 'Cost', { populate: { vehicle: 'plateNumber' } });
      await ctx.models.VehicleCost.deleteOne({ _id: cost._id });
      if (cost.billFile) {
        await discardFiles(ctx, [cost.billFile], 'bill');
        await refreshStorage(ctx);
      }
      await recordAudit(ctx, {
        action: 'cost.deleted',
        entityType: 'cost',
        entityId: costId,
        summary: `Deleted the ${cost.amount} cost "${cost.title}" for ${cost.vehicle?.plateNumber ?? 'a deleted vehicle'}`
      });
      return { id: costId, deleted: true };
    },

    async listFuelLogs(ctx, query) {
      return (await listFuelDocs(ctx, query)).map(presentFuelLog);
    },

    /** Either the price per liter or the total is enough; the other is worked out. */
    async createFuelLog(ctx, input) {
      const data = parse(FuelInputSchema, input);
      const vehicle = await findOr404(ctx.models.Vehicle, data.vehicleId, 'Vehicle');
      const totalCost = data.totalCost ?? round2(data.liters * data.pricePerLiter);
      const pricePerLiter = data.pricePerLiter ?? round2(totalCost / data.liters);
      const { vehicleId, filledAt, ...fields } = data;
      const log = await ctx.models.FuelLog.create({
        ...fields,
        totalCost,
        pricePerLiter,
        vehicle: vehicle._id,
        filledAt: toDate(filledAt ?? todayIn(ctx.timezone)),
        createdBy: ctx.actor
      });
      await raiseMileage(ctx, vehicle._id, data.odometer);
      await recordAudit(ctx, { action: 'fuel.logged', entityType: 'fuel_log', entityId: String(log._id), summary: `Logged ${data.liters} L for ${vehicle.plateNumber}` });
      return presentFuelLog({ ...log.toObject(), vehicle });
    }
  };
}

module.exports = { createCosts };
