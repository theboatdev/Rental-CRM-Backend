const { invalid } = require('../platform/errors');
const { todayIn, toDate, addDays, dateString, can, moduleOn } = require('./common');
const { vehicleRef, complianceOf } = require('./presenters');
const { vehicleTotals, presentTotals, serviceDue } = require('./metrics');
const { signOf } = require('./payments');

const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null };

/** Payment types that count as rental income when summing collections (deposits are held, not earned). */
const INCOME_TYPES = ['ADVANCE', 'RENTAL', 'DAMAGE', 'LATE_FEE', 'REFUND'];

const sum = (items, pick) => items.reduce((total, item) => total + (pick(item) ?? 0), 0);

async function loadSnapshot(ctx, { from, to }) {
  const { Vehicle, Rental } = ctx.models;
  const [vehicles, totals, lifetime, open] = await Promise.all([
    Vehicle.find().sort({ plateNumber: 1 }).lean(),
    vehicleTotals(ctx, { from, to }),
    vehicleTotals(ctx),
    Rental.find({ status: { $in: ['RESERVED', 'ACTIVE'] } })
      .populate('vehicle', 'plateNumber make model')
      .populate('renter', 'profileId fullName phone residentType documents')
      .lean()
  ]);
  return { vehicles, totals, lifetime, open };
}

/**
 * Things that need attention now: overdue returns, vehicles due a service,
 * vehicles in maintenance, and open rentals whose renter lacks compliance
 * documents (e.g. a tourist without a driving permit).
 */
function alertsFor(ctx, { vehicles, lifetime, open }, today) {
  const alerts = [];
  for (const r of open) {
    const end = dateString(r.endDate);
    if (r.status === 'ACTIVE' && end < today) {
      alerts.push({ kind: 'overdue', rentalId: String(r._id), title: `${r.code} is overdue`, detail: `${r.vehicle.plateNumber} with ${r.renter.fullName}, due ${end}` });
    }
    const compliance = complianceOf(r.renter, ctx.config);
    if (!compliance.ok) {
      const missing = [...compliance.missingDocuments, ...(compliance.needsPermit ? ['a driving permit'] : [])];
      alerts.push({ kind: 'compliance', rentalId: String(r._id), renterId: String(r.renter._id), title: `${r.renter.fullName} (${r.renter.profileId}) is missing documents`, detail: `${r.code}: needs ${missing.join(', ')}` });
    }
  }
  for (const v of vehicles) {
    if (v.status === 'MAINTENANCE') {
      alerts.push({ kind: 'maintenance', vehicleId: String(v._id), title: `${v.plateNumber} is in maintenance`, detail: `${v.make} ${v.model}` });
    } else if (serviceDue(ctx, v, lifetime.of(v._id).lastServiceOdometer)) {
      const last = lifetime.of(v._id).lastServiceOdometer;
      alerts.push({ kind: 'service_due', vehicleId: String(v._id), title: `${v.plateNumber} is due a service`, detail: `${v.mileage} on the odometer; last service ${last != null ? `at ${last}` : 'not recorded'}` });
    }
  }
  return alerts;
}

function createDashboard() {
  return {
    /**
     * The operations dashboard for a range (7d, 30d, 90d or all): fleet
     * status, open rentals, per-vehicle figures and alerts. Revenue, operating
     * costs, profit and margin are stripped for callers without financials:view.
     */
    async dashboard(ctx, { range = '30d' } = {}) {
      if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) throw invalid('range must be 7d, 30d, 90d or all');
      const today = todayIn(ctx.timezone);
      const from = RANGES[range] ? addDays(today, -(RANGES[range] - 1)) : null;
      const to = RANGES[range] ? today : null;
      const snapshot = await loadSnapshot(ctx, { from, to });
      const { vehicles, totals, open } = snapshot;

      const count = (status) => vehicles.filter((v) => v.status === status).length;
      const perVehicle = vehicles.map((v) => ({ ...vehicleRef(v), status: v.status, mileage: v.mileage, ...presentTotals(ctx, totals.of(v._id)) }));
      const all = vehicles.map((v) => totals.of(v._id));
      const revenue = sum(all, (t) => t.revenue);
      const operatingCosts = sum(all, (t) => t.serviceCosts + t.fuelCosts);
      const showCosts = can(ctx, 'costs:read') && moduleOn(ctx, 'costs');
      const showFuel = can(ctx, 'fuel:read') && moduleOn(ctx, 'fuelLogs');

      return {
        range,
        from,
        to: today,
        fleet: {
          total: vehicles.length,
          available: count('AVAILABLE'),
          rented: count('RENTED'),
          maintenance: count('MAINTENANCE'),
          utilization: vehicles.length ? count('RENTED') / vehicles.length : 0
        },
        rentals: {
          active: open.filter((r) => r.status === 'ACTIVE').length,
          reserved: open.filter((r) => r.status === 'RESERVED').length,
          overdue: open.filter((r) => r.status === 'ACTIVE' && dateString(r.endDate) < today).length,
          returnsToday: open.filter((r) => r.status === 'ACTIVE' && dateString(r.endDate) === today).length,
          pickupsToday: open.filter((r) => r.status === 'RESERVED' && dateString(r.startDate) === today).length
        },
        totals: {
          trips: sum(all, (t) => t.trips),
          ...(showCosts ? { serviceCosts: sum(all, (t) => t.serviceCosts) } : {}),
          ...(showFuel ? { fuelCosts: sum(all, (t) => t.fuelCosts), fuelLiters: sum(all, (t) => t.fuelLiters) } : {}),
          revenue,
          operatingCosts,
          profit: revenue - operatingCosts,
          profitMargin: revenue ? (revenue - operatingCosts) / revenue : null
        },
        vehicles: perVehicle,
        alerts: alertsFor(ctx, snapshot, today)
      };
    },

    /**
     * The weekly WhatsApp digest for the last 7 days, as the text that's sent.
     * Money lines are only included for callers with financials:view.
     * Sending it on the schedule is Phase 5; the tenant app opens it in WhatsApp.
     */
    async whatsappDigest(ctx) {
      const today = todayIn(ctx.timezone);
      const from = addDays(today, -6);
      const snapshot = await loadSnapshot(ctx, { from, to: today });
      const { vehicles, totals, open } = snapshot;
      const { locale, branding, modules } = ctx.config;
      const money = new Intl.NumberFormat(locale.dateLocale, { style: 'currency', currency: locale.currency, maximumFractionDigits: 0 });
      // Calendar dates are stored as UTC midnight, so they're formatted in UTC to keep the day.
      const date = new Intl.DateTimeFormat(locale.dateLocale, { dateStyle: 'medium', timeZone: 'UTC' });
      const includesFinancials = can(ctx, 'financials:view');

      const count = (status) => vehicles.filter((v) => v.status === status).length;
      const active = open.filter((r) => r.status === 'ACTIVE');
      const alerts = alertsFor(ctx, snapshot, today);
      const lines = [
        `*${branding.displayName.toUpperCase()} — WEEKLY FLEET DIGEST*`,
        `${date.format(toDate(from))} – ${date.format(toDate(today))}`,
        '',
        '*FLEET*',
        `• ${vehicles.length} vehicles: ${count('RENTED')} on the road, ${count('AVAILABLE')} available, ${count('MAINTENANCE')} in maintenance`,
        `• Utilization: ${vehicles.length ? Math.round((count('RENTED') / vehicles.length) * 100) : 0}%`
      ];

      if (includesFinancials) {
        const payments = moduleOn(ctx, 'payments')
          ? await ctx.models.Payment.find({ voidedAt: null, type: { $in: INCOME_TYPES }, paidAt: { $gte: toDate(from) } }).lean()
          : [];
        const collected = sum(payments, (p) => signOf(p.type) * p.amount);
        const weekly = vehicles.map((v) => ({ plate: v.plateNumber, t: totals.of(v._id) }));
        const costs = sum(weekly, ({ t }) => t.serviceCosts + t.fuelCosts);
        const ranked = weekly
          .map(({ plate, t }) => ({ plate, profit: t.revenue - t.serviceCosts - t.fuelCosts }))
          .sort((a, b) => b.profit - a.profit);
        lines.push(
          '',
          '*LAST 7 DAYS*',
          `• Collected: ${money.format(collected)}`,
          `• Service and fuel costs: ${money.format(costs)}`,
          ...(ranked.length ? [`• Top vehicle: ${ranked[0].plate} (${money.format(ranked[0].profit)})`] : []),
          ...(ranked.length > 1 && ranked.at(-1).profit < 0 ? [`• Loss-making: ${ranked.at(-1).plate} (${money.format(ranked.at(-1).profit)})`] : [])
        );
      }

      lines.push('', `*ACTIVE RENTALS (${active.length})*`);
      for (const r of active) lines.push(`• ${r.vehicle.plateNumber} — ${r.renter.fullName}, due ${date.format(r.endDate)}`);
      if (alerts.length) {
        lines.push('', '*ACTION ITEMS*');
        for (const alert of alerts) lines.push(`• ${alert.title}: ${alert.detail}`);
      }
      lines.push('', `_Sent by ${branding.shortName} operations_`);

      return {
        message: lines.join('\n'),
        recipients: modules.whatsappDigest.recipients,
        cron: modules.whatsappDigest.cron,
        timezone: locale.timezone,
        includesFinancials,
        generatedAt: new Date().toISOString()
      };
    }
  };
}

module.exports = { createDashboard };
