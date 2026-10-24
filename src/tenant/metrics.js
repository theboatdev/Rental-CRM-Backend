const { toDate, can, moduleOn } = require('./common');

const inRange = (field, from, to) =>
  from || to ? { [field]: { ...(from ? { $gte: toDate(from) } : {}), ...(to ? { $lte: toDate(to) } : {}) } } : {};

const blankTotals = () => ({ trips: 0, renters: 0, distance: 0, revenue: 0, serviceCosts: 0, fuelCosts: 0, fuelLiters: 0, lastServiceOdometer: null });

/**
 * Per-vehicle totals, keyed by vehicle id, over an optional YYYY-MM-DD range:
 * trips, distinct renters, distance and revenue of active and completed
 * rentals (by start date), service costs (by date) and fuel (by fill-up date).
 * Revenue is the contract value of those rentals, not what was collected.
 */
async function vehicleTotals(ctx, { from, to } = {}) {
  const { Rental, VehicleCost, FuelLog } = ctx.models;
  const [rentals, costs, fuel] = await Promise.all([
    Rental.aggregate([
      { $match: { status: { $in: ['ACTIVE', 'COMPLETED'] }, ...inRange('startDate', from, to) } },
      {
        $group: {
          _id: '$vehicle',
          trips: { $sum: 1 },
          renters: { $addToSet: '$renter' },
          revenue: { $sum: '$totalAmount' },
          distance: {
            $sum: {
              $cond: [{ $and: [{ $gt: ['$endMileage', null] }, { $gt: ['$startMileage', null] }] }, { $subtract: ['$endMileage', '$startMileage'] }, 0]
            }
          }
        }
      }
    ]),
    VehicleCost.aggregate([
      { $match: inRange('incurredAt', from, to) },
      { $group: { _id: '$vehicle', serviceCosts: { $sum: '$amount' }, lastServiceOdometer: { $max: '$odometer' } } }
    ]),
    FuelLog.aggregate([
      { $match: inRange('filledAt', from, to) },
      { $group: { _id: '$vehicle', fuelCosts: { $sum: '$totalCost' }, fuelLiters: { $sum: '$liters' } } }
    ])
  ]);

  const totals = new Map();
  const entry = (id) => {
    const key = String(id);
    if (!totals.has(key)) totals.set(key, blankTotals());
    return totals.get(key);
  };
  for (const r of rentals) Object.assign(entry(r._id), { trips: r.trips, renters: r.renters.length, revenue: r.revenue, distance: r.distance });
  for (const c of costs) Object.assign(entry(c._id), { serviceCosts: c.serviceCosts, lastServiceOdometer: c.lastServiceOdometer ?? null });
  for (const f of fuel) Object.assign(entry(f._id), { fuelCosts: f.fuelCosts, fuelLiters: f.fuelLiters });
  return { of: (vehicleId) => totals.get(String(vehicleId)) ?? blankTotals() };
}

/**
 * Totals as the caller may see them. Cost figures need costs:read (and fuel
 * figures fuel:read) with the module on. `revenue`, `operatingCosts` and
 * `profit` are always included; the tenant API strips them unless the caller
 * has financials:view.
 */
function presentTotals(ctx, t) {
  const operatingCosts = t.serviceCosts + t.fuelCosts;
  return {
    trips: t.trips,
    renters: t.renters,
    distance: t.distance,
    ...(can(ctx, 'costs:read') && moduleOn(ctx, 'costs') ? { serviceCosts: t.serviceCosts } : {}),
    ...(can(ctx, 'fuel:read') && moduleOn(ctx, 'fuelLogs') ? { fuelCosts: t.fuelCosts, fuelLiters: t.fuelLiters } : {}),
    revenue: t.revenue,
    operatingCosts,
    profit: t.revenue - operatingCosts
  };
}

/** Whether a vehicle is due a service: `modules.vehicles.serviceIntervalKm` since the last service with an odometer reading. */
function serviceDue(ctx, vehicle, lastServiceOdometer) {
  const interval = ctx.config.modules.vehicles.serviceIntervalKm;
  return vehicle.mileage - (lastServiceOdometer ?? 0) >= interval;
}

module.exports = { vehicleTotals, presentTotals, serviceDue, inRange };
