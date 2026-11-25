const { z } = require('zod');
const { RENTAL_STATUSES } = require('../models/tenant/enums');
const { conflict, forbidden, invalid } = require('../platform/errors');
const {
  parse,
  findOr404,
  inTransaction,
  lock,
  nextCode,
  todayIn,
  toDate,
  dateString,
  addDays,
  daysBetween,
  rentalDays,
  DateStringSchema,
  IdSchema,
  activeListKey,
  can,
  moduleOn
} = require('./common');
const { presentRental, presentPayment, vehicleRef, owedOn } = require('./presenters');
const { recordPaymentIn } = require('./payments');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields, customFieldFiles, discardReplacedFieldFiles } = require('./fields');
const { fileInput } = require('./files');
const { refreshStorageUsage } = require('../platform/usage');

/**
 * Rentals and bookings: reserve, check in, return, cancel. These are the
 * rules the demo app kept in lib/bookings.mjs, run in transactions. Every
 * change to a vehicle's bookings first locks that vehicle, so two bookings
 * can't take the same days.
 *
 * A booking (RESERVED) gets a code with the `booking` prefix (BK-2026-0043).
 * Check-in makes it ACTIVE with a `rental` code (RNT-2026-0042) and keeps
 * the booking code. Dates are the tenant's calendar dates; a rental holds its
 * vehicle from the start date up to (not including) the end date.
 */

/** A pickup or drop inspection: the checked points, a photo per point (uploaded as `inspection` files), the odometer and notes. */
const InspectionSchema = (ctx) =>
  z.strictObject({
    odometer: z.number().int().min(0).optional(),
    checkedPoints: z.array(z.string().max(80)).max(30).default([]),
    photos: z.array(z.strictObject({ point: z.string().max(80), file: fileInput(ctx, 'inspection') })).max(30).default([]),
    notes: z.string().trim().max(1000).default('')
  });

/** A hand-over: the pickup inspection, and whether staff confirm the renter has paid the full amount. */
const CheckInSchema = (ctx) => InspectionSchema(ctx).extend({ confirmFullPayment: z.boolean().default(false) });

const ReturnSchema = (ctx) => z.strictObject({ ...InspectionSchema(ctx).shape, odometer: z.number().int().min(0) });

const MakeModelSchema = z.string().trim().min(1).max(80);

const ReservationSchema = (ctx) =>
  z.strictObject({
    // Either a specific plate, or a make+model class hold (see reservationMode).
    vehicleId: IdSchema.optional(),
    requestedMake: MakeModelSchema.optional(),
    requestedModel: MakeModelSchema.optional(),
    renterId: IdSchema,
    startDate: DateStringSchema,
    endDate: DateStringSchema,
    dailyRate: ctx.config.modules.vehicles.rateOnVehicle !== false ? z.number().positive().optional() : z.number().positive(),
    depositAmount: z.number().min(0).optional(),
    // Payable to a third-party vehicle supplier; only kept when the feature is on and the vehicle is THIRD_PARTY.
    supplierRentalCost: z.number().min(0).optional(),
    // An advance collected with the booking (needs payments:record).
    advance: z
      .strictObject({
        amount: z.number().positive(),
        method: activeListKey(ctx.config, 'paymentMethods'),
        transactionReference: z.string().trim().max(80).optional(),
        notes: z.string().trim().max(500).optional(),
        customFields: customFieldsInput(ctx, 'payments')
      })
      .optional(),
    notes: z.string().trim().max(1000).default(''),
    customFields: customFieldsInput(ctx, 'rentals'),
    // Hand the vehicle over straight away (needs rentals:checkin): booking and check-in in one step.
    // Only allowed when a specific vehicleId is provided.
    pickup: CheckInSchema(ctx).optional()
  });

/** Assign (or reassign) a plate to a RESERVED booking that was held by make/model. */
const AssignVehicleSchema = z.strictObject({
  vehicleId: IdSchema,
  // Same rules as booking: kept when third-party tracking is on and the assigned plate is THIRD_PARTY.
  supplierRentalCost: z.number().min(0).optional()
});

/** Supplier hire cost to persist on a rental, or undefined when the feature/vehicle doesn't apply. */
function supplierCostFor(ctx, vehicle, supplierRentalCost) {
  if (!ctx.config.modules.vehicles.thirdPartyVehicles) return undefined;
  if ((vehicle.ownership ?? 'OWNED') !== 'THIRD_PARTY') return undefined;
  return supplierRentalCost ?? 0;
}

/** Notes and custom fields stay editable whatever the rental's status; dates and amounts don't change here. */
const RentalUpdateSchema = (ctx) =>
  z.strictObject({ notes: z.string().trim().max(1000).optional(), customFields: customFieldsInput(ctx, 'rentals', { update: true }) });

const AvailabilityQuerySchema = z.strictObject({ startDate: DateStringSchema, endDate: DateStringSchema, excludeRentalId: IdSchema.optional() });

const POPULATE = { vehicle: 'plateNumber make model', renter: 'profileId fullName phone' };

const reservationModeOf = (ctx) => ctx.config.modules.rentals.reservationMode ?? 'specificVehicle';

const classKey = (make, model) => `${make.trim().toLowerCase()}\0${model.trim().toLowerCase()}`;

/**
 * The first day a rental no longer holds its vehicle. Return day is inclusive
 * (charged and blocked), so the vehicle frees the day after endDate. An active
 * rental holds it until it's returned, even past its end date.
 */
function heldUntil(rental, today) {
  const freeFrom = addDays(dateString(rental.endDate), 1);
  return rental.status === 'ACTIVE' && freeFrom <= today ? addDays(today, 1) : freeFrom;
}

const describeBooking = (rental, today) => `${rental.code} (${dateString(rental.startDate)} to ${dateString(rental.endDate)})`;

/** The first reservation or active rental of the vehicle that overlaps [startDate, endDate]. */
async function findOverlap(ctx, { vehicleId, startDate, endDate, excludeId, session }) {
  const today = todayIn(ctx.timezone);
  const candidates = await ctx.models.Rental.find({
    vehicle: vehicleId,
    status: { $in: ['RESERVED', 'ACTIVE'] },
    startDate: { $lte: toDate(endDate) },
    ...(excludeId ? { _id: { $ne: excludeId } } : {})
  })
    .session(session ?? null)
    .lean();
  return candidates.find((rental) => heldUntil(rental, today) > startDate) ?? null;
}

/**
 * Unassigned make/model holds that overlap [startDate, endDate].
 * These consume pool capacity without locking a plate yet.
 */
async function findClassHolds(ctx, { make, model, startDate, endDate, excludeId, session }) {
  const today = todayIn(ctx.timezone);
  const candidates = await ctx.models.Rental.find({
    vehicle: null,
    status: 'RESERVED',
    requestedMake: new RegExp(`^${escapeRegex(make.trim())}$`, 'i'),
    requestedModel: new RegExp(`^${escapeRegex(model.trim())}$`, 'i'),
    startDate: { $lte: toDate(endDate) },
    ...(excludeId ? { _id: { $ne: excludeId } } : {})
  })
    .session(session ?? null)
    .lean();
  return candidates.filter((rental) => heldUntil(rental, today) > startDate);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How many plates of this make/model are free for the dates, minus overlapping
 * unassigned class holds. `sample` is a free vehicle used for default rates.
 */
async function classAvailability(ctx, { make, model, startDate, endDate, excludeId, session }) {
  const pool = await ctx.models.Vehicle.find({
    make: new RegExp(`^${escapeRegex(make.trim())}$`, 'i'),
    model: new RegExp(`^${escapeRegex(model.trim())}$`, 'i'),
    status: { $ne: 'MAINTENANCE' }
  })
    .session(session ?? null)
    .lean();
  const free = [];
  for (const vehicle of pool) {
    const overlap = await findOverlap(ctx, { vehicleId: vehicle._id, startDate, endDate, excludeId, session });
    if (!overlap) free.push(vehicle);
  }
  const holds = await findClassHolds(ctx, { make, model, startDate, endDate, excludeId, session });
  const availableCount = Math.max(0, free.length - holds.length);
  // Prefer the cheapest free plate for default rate/deposit (unpriced plates sort last).
  const rateOf = (v) => (v.dailyRate == null ? Number.POSITIVE_INFINITY : v.dailyRate);
  const sample = [...free].sort((a, b) => rateOf(a) - rateOf(b) || a.depositAmount - b.depositAmount)[0] ?? null;
  return {
    make: sample?.make ?? make.trim(),
    model: sample?.model ?? model.trim(),
    fleetCount: pool.length,
    freePlates: free.length,
    classHolds: holds.length,
    availableCount,
    sample,
    free
  };
}

/** Ensures booking a specific plate still leaves enough free plates for existing class holds. */
async function assertPlateLeavesClassCapacity(ctx, vehicle, { startDate, endDate, excludeId, session }) {
  const capacity = await classAvailability(ctx, {
    make: vehicle.make,
    model: vehicle.model,
    startDate,
    endDate,
    excludeId,
    session
  });
  // This plate is currently counted as free; taking it reduces freePlates by 1.
  if (capacity.freePlates - 1 < capacity.classHolds) {
    throw conflict(
      `Can't book ${vehicle.plateNumber}: ${capacity.classHolds} unassigned ${vehicle.make} ${vehicle.model} reservation(s) still need a plate for these dates`
    );
  }
}

/**
 * An inspection record from the checked points (`modules.rentals.inspectionPoints`)
 * and their photos, in the config's order. A point with a photo counts as
 * checked. With `required`, every point must be checked.
 */
function inspectionOf(ctx, input, { required, odometer }) {
  const points = ctx.config.modules.rentals.inspectionPoints;
  const photoOf = new Map();
  input.photos.forEach((photo, index) => {
    if (photoOf.has(photo.point)) throw invalid(`There are two photos of ${photo.point}`, [{ path: `photos[${index}].point`, message: 'Already has a photo' }]);
    photoOf.set(photo.point, photo.file);
  });
  const checked = new Set([...input.checkedPoints, ...photoOf.keys()]);
  const unknown = [...checked].filter((point) => !points.includes(point));
  if (unknown.length) throw invalid(`Unknown inspection points: ${unknown.join(', ')}`, [{ path: 'checkedPoints', message: 'Unknown point' }]);
  if (required) {
    const missing = points.filter((point) => !checked.has(point));
    if (missing.length) {
      throw invalid(`Check every inspection point first: ${missing.join(', ')}`, [{ path: 'checkedPoints', message: `Missing: ${missing.join(', ')}` }]);
    }
  }
  const photos = points.filter((point) => checked.has(point)).map((point) => (photoOf.has(point) ? { point, file: photoOf.get(point) } : { point }));
  return { at: new Date(), by: ctx.actor, odometer, photos, notes: input.notes };
}

const hasPhotos = (inspection) => inspection?.photos.some((photo) => photo.file);

/**
 * The caller's confirmation that a rental is paid in full. With the payments
 * module on, the ledger must agree: nothing may be owed. Without it, the
 * confirmation is staff's word. `path` reports a refusal against a form field.
 */
function fullPaymentBy(ctx, rental, { path } = {}) {
  const owed = owedOn(rental);
  if (moduleOn(ctx, 'payments') && owed > 0) {
    const { dateLocale, currency } = ctx.config.locale;
    const amount = new Intl.NumberFormat(dateLocale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(owed);
    const message = `${amount} is still to be paid for ${rental.code}. Record the payment, then confirm the full amount.`;
    throw path ? invalid(message, [{ path, message: `${amount} still to be paid` }]) : conflict(message);
  }
  return { at: new Date(), by: ctx.actor };
}

/** A booking's length in days, after checking its dates against the tenant's rules. */
function bookingDays(ctx, { startDate, endDate }) {
  if (daysBetween(startDate, endDate) < 0) {
    throw invalid('The return date must be on or after the pickup date', [{ path: 'endDate', message: 'Before the pickup date' }]);
  }
  const totalDays = rentalDays(startDate, endDate);
  const minDays = Math.max(1, ctx.config.rules.minRentalDays);
  if (totalDays < minDays) throw invalid(`Rentals are at least ${minDays} days`, [{ path: 'endDate', message: `At least ${minDays} days` }]);
  if (startDate < todayIn(ctx.timezone)) throw invalid('The pickup date is in the past', [{ path: 'startDate', message: 'In the past' }]);
  return totalDays;
}

/**
 * Validates reservationMode against the payload: specific plate, make+model
 * class hold, or either when mode is `both`.
 */
function resolveReservationTarget(ctx, data) {
  const mode = reservationModeOf(ctx);
  const hasVehicle = Boolean(data.vehicleId);
  const hasClass = Boolean(data.requestedMake && data.requestedModel);
  if (hasVehicle && hasClass) {
    throw invalid('Choose either a specific vehicle or a make and model, not both', [
      { path: 'vehicleId', message: 'Pick one style of reservation' }
    ]);
  }
  if (hasVehicle) {
    if (mode === 'vehicleClass') {
      throw invalid('This tenant reserves by make and model; pick a vehicle class instead of a plate', [
        { path: 'vehicleId', message: 'Not allowed in vehicleClass mode' }
      ]);
    }
    return { kind: 'vehicle', vehicleId: data.vehicleId };
  }
  if (hasClass) {
    if (mode === 'specificVehicle') {
      throw invalid('This tenant requires a specific vehicle registration', [
        { path: 'requestedMake', message: 'Not allowed in specificVehicle mode' }
      ]);
    }
    return { kind: 'class', make: data.requestedMake, model: data.requestedModel };
  }
  if (mode === 'vehicleClass') {
    throw invalid('Choose a vehicle make and model', [
      { path: 'requestedMake', message: 'Required' },
      { path: 'requestedModel', message: 'Required' }
    ]);
  }
  throw invalid('Choose a vehicle', [{ path: 'vehicleId', message: 'Required' }]);
}

/**
 * Inside a transaction: books a vehicle for a renter, after locking the
 * vehicle and checking it's free for the dates. The rate and deposit default
 * to the vehicle's. Returns the new RESERVED rental with its vehicle and renter.
 * The guest portal books through it too, with `source: 'ONLINE'`.
 */
async function bookWithin(ctx, session, data, { source = 'COUNTER' } = {}) {
  const totalDays = bookingDays(ctx, data);
  const today = todayIn(ctx.timezone);
  await lock(ctx, `vehicle:${data.vehicleId}`, session);
  const vehicle = await findOr404(ctx.models.Vehicle, data.vehicleId, 'Vehicle', { session });
  const renter = await findOr404(ctx.models.Renter, data.renterId, 'Renter', { session });
  if (vehicle.status === 'MAINTENANCE') throw conflict(`${vehicle.plateNumber} is in maintenance`);
  const overlap = await findOverlap(ctx, { vehicleId: vehicle._id, startDate: data.startDate, endDate: data.endDate, session });
  if (overlap) throw conflict(`Conflicts with ${describeBooking(overlap, today)}`);
  await assertPlateLeavesClassCapacity(ctx, vehicle, { startDate: data.startDate, endDate: data.endDate, session });

  const dailyRate = data.dailyRate ?? vehicle.dailyRate ?? null;
  if (dailyRate == null) {
    throw invalid('Enter the daily rate for this booking', [{ path: 'dailyRate', message: 'Required' }]);
  }
  const depositAmount = data.depositAmount ?? vehicle.depositAmount;
  const supplierRentalCost = supplierCostFor(ctx, vehicle, data.supplierRentalCost);
  const code = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.booking, sequence: 'booking', year: today.slice(0, 4), session });
  const [created] = await ctx.models.Rental.create(
    [
      {
        code,
        renter: renter._id,
        vehicle: vehicle._id,
        requestedMake: vehicle.make,
        requestedModel: vehicle.model,
        status: 'RESERVED',
        source,
        startDate: toDate(data.startDate),
        endDate: toDate(data.endDate),
        totalDays,
        dailyRate,
        totalAmount: totalDays * dailyRate,
        depositAmount,
        ...(supplierRentalCost != null ? { supplierRentalCost } : {}),
        paidAmount: 0,
        createdBy: ctx.actor,
        notes: data.notes ?? '',
        customFields: data.customFields
      }
    ],
    { session }
  );
  return { rental: created.toObject(), vehicle, renter };
}

/**
 * Inside a transaction: holds capacity for a make/model without assigning a
 * plate. Rate/deposit default from the cheapest free vehicle in that class.
 */
async function bookClassWithin(ctx, session, data, { source = 'COUNTER' } = {}) {
  const totalDays = bookingDays(ctx, data);
  const today = todayIn(ctx.timezone);
  const lockKey = `class:${classKey(data.requestedMake, data.requestedModel)}`;
  await lock(ctx, lockKey, session);
  const capacity = await classAvailability(ctx, {
    make: data.requestedMake,
    model: data.requestedModel,
    startDate: data.startDate,
    endDate: data.endDate,
    session
  });
  if (capacity.fleetCount === 0) {
    throw invalid(`No ${data.requestedMake} ${data.requestedModel} vehicles in the fleet`, [
      { path: 'requestedMake', message: 'Unknown make/model' }
    ]);
  }
  if (capacity.availableCount < 1) {
    throw conflict(
      `No ${capacity.make} ${capacity.model} left for these dates (${capacity.freePlates} free plate(s), ${capacity.classHolds} unassigned hold(s))`
    );
  }
  const renter = await findOr404(ctx.models.Renter, data.renterId, 'Renter', { session });
  const dailyRate = data.dailyRate ?? capacity.sample?.dailyRate ?? null;
  if (dailyRate == null) {
    throw invalid('Enter the daily rate for this booking', [{ path: 'dailyRate', message: 'Required' }]);
  }
  const depositAmount = data.depositAmount ?? capacity.sample?.depositAmount;
  const code = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.booking, sequence: 'booking', year: today.slice(0, 4), session });
  const [created] = await ctx.models.Rental.create(
    [
      {
        code,
        renter: renter._id,
        vehicle: null,
        requestedMake: capacity.make,
        requestedModel: capacity.model,
        status: 'RESERVED',
        source,
        startDate: toDate(data.startDate),
        endDate: toDate(data.endDate),
        totalDays,
        dailyRate,
        totalAmount: totalDays * dailyRate,
        depositAmount,
        paidAmount: 0,
        createdBy: ctx.actor,
        notes: data.notes ?? '',
        customFields: data.customFields
      }
    ],
    { session }
  );
  return { rental: created.toObject(), vehicle: null, renter, requestedMake: capacity.make, requestedModel: capacity.model };
}

function createRentals({ platformDb }) {
  const refreshStorage = (ctx) => refreshStorageUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, models: ctx.models });

  /** Inside a transaction: checks a RESERVED rental in, renting its vehicle out. */
  async function checkInWithin(ctx, session, rental, input) {
    const today = todayIn(ctx.timezone);
    if (rental.status !== 'RESERVED') throw conflict(`${rental.code} isn't waiting for pickup any more`);
    if (!rental.vehicle) {
      throw conflict(`${rental.code} still needs a vehicle assigned before handover`);
    }
    await lock(ctx, `vehicle:${rental.vehicle}`, session);
    const vehicle = await findOr404(ctx.models.Vehicle, rental.vehicle, 'Vehicle', { session });
    const start = dateString(rental.startDate);
    const end = dateString(rental.endDate);
    if (today < start || today >= end) throw conflict(`${rental.code} can only be checked in from ${start} until the day before ${end}`);
    if (vehicle.status === 'RENTED') throw conflict(`${vehicle.plateNumber} is still out on another rental. Record that return first.`);
    if (vehicle.status === 'MAINTENANCE') throw conflict(`${vehicle.plateNumber} is in maintenance`);
    const overlap = await findOverlap(ctx, { vehicleId: vehicle._id, startDate: start, endDate: end, excludeId: rental._id, session });
    if (overlap) throw conflict(`Conflicts with ${describeBooking(overlap, today)}`);

    const odometer = input.odometer ?? vehicle.mileage;
    if (odometer < vehicle.mileage) {
      throw invalid(`The odometer can't be below the vehicle's last reading (${vehicle.mileage})`, [{ path: 'odometer', message: 'Below the last reading' }]);
    }
    const pickupInspection = inspectionOf(ctx, input, { required: ctx.config.modules.rentals.requirePickupInspection, odometer });
    const fullPayment = input.confirmFullPayment ? fullPaymentBy(ctx, rental, { path: input.fullPaymentPath ?? 'confirmFullPayment' }) : null;
    const code = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.rental, sequence: 'rental', year: today.slice(0, 4), session });
    await ctx.models.Rental.updateOne(
      { _id: rental._id, status: 'RESERVED' },
      { $set: { status: 'ACTIVE', code, bookingCode: rental.code, startMileage: odometer, pickupInspection, ...(fullPayment ? { fullPayment } : {}) } },
      { session }
    );
    await ctx.models.Vehicle.updateOne({ _id: vehicle._id }, { $set: { status: 'RENTED', mileage: odometer } }, { session });
    return { code, plateNumber: vehicle.plateNumber, photos: hasPhotos(pickupInspection), fullyPaid: Boolean(fullPayment) };
  }

  async function getRental(ctx, rentalId) {
    const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { populate: POPULATE });
    const showPayments = can(ctx, 'payments:read') && moduleOn(ctx, 'payments');
    const payments = showPayments
      ? await ctx.models.Payment.find({ rental: rental._id }).sort({ paidAt: -1 }).lean()
      : null;
    return {
      ...presentRental(rental, ctx),
      payments: payments && payments.map((p) => presentPayment({ ...p, rental, renter: rental.renter }, ctx))
    };
  }

  return {
    getRental,

    /** Newest start date first. `status` is one of the rental statuses, or `open` for reservations and active rentals. */
    async listRentals(ctx, { status, vehicleId, renterId } = {}) {
      const filter = {};
      if (status === 'open') filter.status = { $in: ['RESERVED', 'ACTIVE'] };
      else if (status !== undefined) {
        if (!RENTAL_STATUSES.includes(status)) throw invalid(`status must be open or one of ${RENTAL_STATUSES.join(', ')}`);
        filter.status = status;
      }
      if (IdSchema.safeParse(vehicleId).success) filter.vehicle = vehicleId;
      if (IdSchema.safeParse(renterId).success) filter.renter = renterId;
      let query = ctx.models.Rental.find(filter).sort({ startDate: -1, createdAt: -1 });
      for (const [path, select] of Object.entries(POPULATE)) query = query.populate(path, select);
      return (await query.lean()).map((r) => presentRental(r, ctx));
    },

    /**
     * Books a vehicle or a make/model class hold for a renter. Rate and deposit
     * default from the vehicle (or the cheapest free vehicle in the class).
     * Optionally records an advance and hands over at once (specific plate only).
     */
    async reserve(ctx, input) {
      const data = parseRecord(ReservationSchema(ctx), input, ctx.config, 'rentals', { nested: { advance: 'payments' } });
      const target = resolveReservationTarget(ctx, data);
      if (data.pickup && target.kind !== 'vehicle') {
        throw invalid('Handing over now needs a specific vehicle registration', [{ path: 'pickup', message: 'Assign a plate first' }]);
      }
      if (data.pickup && !can(ctx, 'rentals:checkin')) throw forbidden("You don't have the rentals:checkin permission");
      if (data.advance && !(moduleOn(ctx, 'payments') && can(ctx, 'payments:record'))) throw forbidden("You don't have the payments:record permission");
      bookingDays(ctx, data);

      let rentalId;
      let summary;
      let photos = false;
      await inTransaction(ctx, async (session) => {
        const booked =
          target.kind === 'vehicle'
            ? await bookWithin(ctx, session, data)
            : await bookClassWithin(ctx, session, data);
        let { rental } = booked;
        if (data.advance && data.advance.amount > rental.totalAmount + rental.depositAmount) {
          throw invalid('The advance is more than the rental and deposit together', [{ path: 'advance.amount', message: 'More than is owed' }]);
        }
        rentalId = rental._id;
        const vehicleLabel = booked.vehicle
          ? booked.vehicle.plateNumber
          : `${booked.requestedMake} ${booked.requestedModel} (unassigned)`;
        summary = `Booked ${vehicleLabel} for ${booked.renter.fullName} as ${rental.code}, ${data.startDate} to ${data.endDate}`;
        if (data.advance) {
          await recordPaymentIn(ctx, session, rental, { type: 'ADVANCE', ...data.advance });
          rental = { ...rental, paidAmount: data.advance.amount };
        }
        if (data.pickup) {
          const handedOver = await checkInWithin(ctx, session, rental, { ...data.pickup, fullPaymentPath: 'pickup.confirmFullPayment' });
          photos = handedOver.photos;
          summary += `; handed over as ${handedOver.code}${handedOver.fullyPaid ? ', full payment confirmed' : ''}`;
        }
      });
      const fieldFiles = [...customFieldFiles(data.customFields), ...customFieldFiles(data.advance?.customFields)];
      if (photos || fieldFiles.length) await refreshStorage(ctx);
      await recordAudit(ctx, { action: data.pickup ? 'rental.dispatched' : 'rental.reserved', entityType: 'rental', entityId: String(rentalId), summary });
      return getRental(ctx, String(rentalId));
    },

    /**
     * Assigns a plate to a RESERVED make/model hold (or reassigns while still
     * reserved). Required before check-in when the booking has no vehicle yet.
     */
    async assignVehicle(ctx, rentalId, input) {
      const { vehicleId, supplierRentalCost: supplierCostInput } = parse(AssignVehicleSchema, input);
      let summary;
      await inTransaction(ctx, async (session) => {
        const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { session });
        if (rental.status !== 'RESERVED') {
          throw conflict(`Only a reservation can get a vehicle assigned; ${rental.code} is ${rental.status.toLowerCase()}`);
        }
        await lock(ctx, `rental:${rental._id}`, session);
        await lock(ctx, `vehicle:${vehicleId}`, session);
        if (rental.requestedMake && rental.requestedModel) {
          await lock(ctx, `class:${classKey(rental.requestedMake, rental.requestedModel)}`, session);
        }
        const vehicle = await findOr404(ctx.models.Vehicle, vehicleId, 'Vehicle', { session });
        if (vehicle.status === 'MAINTENANCE') throw conflict(`${vehicle.plateNumber} is in maintenance`);
        if (rental.requestedMake && rental.requestedModel) {
          const sameClass =
            vehicle.make.toLowerCase() === rental.requestedMake.toLowerCase() &&
            vehicle.model.toLowerCase() === rental.requestedModel.toLowerCase();
          if (!sameClass) {
            throw invalid(
              `${vehicle.plateNumber} is a ${vehicle.make} ${vehicle.model}, but this reservation is for ${rental.requestedMake} ${rental.requestedModel}`,
              [{ path: 'vehicleId', message: 'Wrong make/model' }]
            );
          }
        }
        const startDate = dateString(rental.startDate);
        const endDate = dateString(rental.endDate);
        const today = todayIn(ctx.timezone);
        const overlap = await findOverlap(ctx, { vehicleId: vehicle._id, startDate, endDate, excludeId: rental._id, session });
        if (overlap) throw conflict(`Conflicts with ${describeBooking(overlap, today)}`);
        // When reassigning from another plate, capacity for the class is unchanged for this rental.
        // When assigning onto a free plate from an unassigned hold, this rental is already counted
        // in classHolds, so freePlates must be at least classHolds (this hold + others).
        if (!rental.vehicle) {
          const capacity = await classAvailability(ctx, {
            make: vehicle.make,
            model: vehicle.model,
            startDate,
            endDate,
            excludeId: rental._id,
            session
          });
          if (capacity.freePlates < 1) {
            throw conflict(`${vehicle.plateNumber} isn't free for these dates`);
          }
        } else if (String(rental.vehicle) !== String(vehicle._id)) {
          await assertPlateLeavesClassCapacity(ctx, vehicle, { startDate, endDate, excludeId: rental._id, session });
        }
        const supplierRentalCost = supplierCostFor(ctx, vehicle, supplierCostInput);
        const $set = {
          vehicle: vehicle._id,
          requestedMake: vehicle.make,
          requestedModel: vehicle.model
        };
        const $unset = {};
        if (supplierRentalCost != null) $set.supplierRentalCost = supplierRentalCost;
        else $unset.supplierRentalCost = 1;
        await ctx.models.Rental.updateOne(
          { _id: rental._id, status: 'RESERVED' },
          { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
          { session }
        );
        summary = `Assigned ${vehicle.plateNumber} to ${rental.code}`;
      });
      await recordAudit(ctx, { action: 'rental.vehicle_assigned', entityType: 'rental', entityId: rentalId, summary });
      return getRental(ctx, rentalId);
    },

    /** Hands the vehicle over. With `confirmFullPayment`, also confirms the renter has paid everything (see fullPaymentBy). */
    async checkIn(ctx, rentalId, input) {
      const data = parse(CheckInSchema(ctx), input);
      let result;
      await inTransaction(ctx, async (session) => {
        const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { session });
        // Locks the rental too, so a payment can't be voided while the full payment is being confirmed.
        await lock(ctx, `rental:${rental._id}`, session);
        result = { ...(await checkInWithin(ctx, session, rental, data)), bookingCode: rental.code };
      });
      if (result.photos) await refreshStorage(ctx);
      await recordAudit(ctx, {
        action: 'rental.checked_in',
        entityType: 'rental',
        entityId: rentalId,
        summary: `Handed over ${result.plateNumber}: ${result.bookingCode} is now ${result.code}${result.fullyPaid ? '; full payment confirmed' : ''}`
      });
      return getRental(ctx, rentalId);
    },

    /**
     * Confirms after the hand-over that an active or completed rental is paid
     * in full, e.g. when the renter paid the rest later.
     */
    async confirmFullPayment(ctx, rentalId) {
      let code;
      await inTransaction(ctx, async (session) => {
        const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { session });
        await lock(ctx, `rental:${rental._id}`, session);
        if (!['ACTIVE', 'COMPLETED'].includes(rental.status)) {
          throw conflict(`The full payment is confirmed at the hand-over or after it; ${rental.code} is ${rental.status.toLowerCase()}`);
        }
        if (rental.fullPayment?.at) throw conflict(`${rental.code} is already confirmed as paid in full`);
        await ctx.models.Rental.updateOne({ _id: rental._id }, { $set: { fullPayment: fullPaymentBy(ctx, rental) } }, { session });
        code = rental.code;
      });
      await recordAudit(ctx, { action: 'rental.full_payment_confirmed', entityType: 'rental', entityId: rentalId, summary: `Confirmed ${code} as paid in full` });
      return getRental(ctx, rentalId);
    },

    async updateRental(ctx, rentalId, input) {
      const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental');
      const { customFields, ...changes } = parseRecord(RentalUpdateSchema(ctx), input, ctx.config, 'rentals', { update: true });
      await ctx.models.Rental.updateOne({ _id: rental._id }, updateWithCustomFields(changes, customFields));
      if (await discardReplacedFieldFiles(ctx, rental, customFields)) await refreshStorage(ctx);
      const fields = [
        ...Object.keys(changes).filter((key) => changes[key] !== (rental[key] ?? '')),
        ...changedCustomFields(rental, customFields)
      ];
      if (fields.length) {
        await recordAudit(ctx, { action: 'rental.updated', entityType: 'rental', entityId: rentalId, summary: `Updated ${rental.code}: ${fields.join(', ')}` });
      }
      return getRental(ctx, rentalId);
    },

    /** Records the return: odometer, drop inspection, and the vehicle back to AVAILABLE. */
    async returnRental(ctx, rentalId, input) {
      const data = parse(ReturnSchema(ctx), input);
      let summary;
      let photos = false;
      await inTransaction(ctx, async (session) => {
        const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { session });
        if (rental.status !== 'ACTIVE') throw conflict(`Only an active rental can be returned; ${rental.code} is ${rental.status.toLowerCase()}`);
        await lock(ctx, `vehicle:${rental.vehicle}`, session);
        if (data.odometer < (rental.startMileage ?? 0)) {
          throw invalid(`The odometer can't be below the pickup reading (${rental.startMileage})`, [{ path: 'odometer', message: 'Below the pickup reading' }]);
        }
        const dropInspection = inspectionOf(ctx, data, { required: ctx.config.modules.rentals.requireDropInspection, odometer: data.odometer });
        photos = hasPhotos(dropInspection);
        await ctx.models.Rental.updateOne(
          { _id: rental._id, status: 'ACTIVE' },
          { $set: { status: 'COMPLETED', endMileage: data.odometer, actualReturnDate: new Date(), dropInspection } },
          { session }
        );
        await ctx.models.Vehicle.updateOne(
          { _id: rental.vehicle, status: 'RENTED' },
          { $set: { status: 'AVAILABLE' }, $max: { mileage: data.odometer } },
          { session }
        );
        summary = `Returned ${rental.code} at ${data.odometer} (${data.odometer - (rental.startMileage ?? 0)} driven)`;
      });
      if (photos) await refreshStorage(ctx);
      await recordAudit(ctx, { action: 'rental.returned', entityType: 'rental', entityId: rentalId, summary });
      return getRental(ctx, rentalId);
    },

    /** Cancels a reservation. Advances stay in the ledger; refund them with a REFUND payment. */
    async cancel(ctx, rentalId) {
      const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental');
      const cancelled = await ctx.models.Rental.findOneAndUpdate(
        { _id: rental._id, status: 'RESERVED' },
        { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
      ).lean();
      if (!cancelled) throw conflict(`Only a reservation can be cancelled; ${rental.code} is ${rental.status.toLowerCase()}`);
      const advance = rental.paidAmount > 0 ? `; ${rental.paidAmount} collected stays in the ledger` : '';
      await recordAudit(ctx, { action: 'rental.cancelled', entityType: 'rental', entityId: rentalId, summary: `Cancelled ${rental.code}${advance}` });
      return getRental(ctx, rentalId);
    },

    /**
     * Per-vehicle availability for [startDate, endDate], plus make/model class
     * availability when the tenant allows class holds.
     */
    async availability(ctx, query) {
      const { startDate, endDate, excludeRentalId } = parse(AvailabilityQuerySchema, query);
      if (daysBetween(startDate, endDate) < 0) {
        throw invalid('The return date must be on or after the pickup date', [{ path: 'endDate', message: 'Before the pickup date' }]);
      }
      const today = todayIn(ctx.timezone);
      const mode = reservationModeOf(ctx);
      const vehicles = await ctx.models.Vehicle.find().sort({ plateNumber: 1 }).lean();
      const vehiclesOut = await Promise.all(
        vehicles.map(async (vehicle) => {
          const overlap =
            vehicle.status === 'MAINTENANCE' ? null : await findOverlap(ctx, { vehicleId: vehicle._id, startDate, endDate, excludeId: excludeRentalId });
          let reason = vehicle.status === 'MAINTENANCE' ? 'In maintenance' : overlap ? `Booked: ${describeBooking(overlap, today)}` : null;
          // Soft-block plates that would leave class holds without a free unit.
          if (!reason) {
            try {
              await assertPlateLeavesClassCapacity(ctx, vehicle, { startDate, endDate, excludeId: excludeRentalId });
            } catch (error) {
              if (error?.code === 'conflict') reason = error.message;
              else throw error;
            }
          }
          return {
            vehicle: vehicleRef(vehicle),
            ownership: vehicle.ownership ?? 'OWNED',
            dailyRate: vehicle.dailyRate ?? null,
            depositAmount: vehicle.depositAmount,
            available: !reason,
            reason
          };
        })
      );

      let classes = [];
      if (mode === 'vehicleClass' || mode === 'both') {
        const seen = new Set();
        for (const vehicle of vehicles) {
          const key = classKey(vehicle.make, vehicle.model);
          if (seen.has(key)) continue;
          seen.add(key);
          const capacity = await classAvailability(ctx, {
            make: vehicle.make,
            model: vehicle.model,
            startDate,
            endDate,
            excludeId: excludeRentalId
          });
          classes.push({
            make: capacity.make,
            model: capacity.model,
            fleetCount: capacity.fleetCount,
            availableCount: capacity.availableCount,
            dailyRate: capacity.sample?.dailyRate ?? vehicle.dailyRate ?? null,
            depositAmount: capacity.sample?.depositAmount ?? vehicle.depositAmount,
            available: capacity.availableCount > 0,
            reason: capacity.availableCount > 0 ? null : 'No units left for these dates'
          });
        }
        classes.sort((a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model));
      }

      return { vehicles: vehiclesOut, classes, reservationMode: mode };
    },

    /** One month of the fleet schedule: every vehicle, and the reservations and rentals that touch the month. */
    async calendar(ctx, { month } = {}) {
      const today = todayIn(ctx.timezone);
      const value = month ?? today.slice(0, 7);
      if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw invalid('month must look like 2026-10');
      const first = `${value}-01`;
      const next = dateString(new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)), 1)));
      const [vehicles, rentals] = await Promise.all([
        ctx.models.Vehicle.find().sort({ plateNumber: 1 }).lean(),
        ctx.models.Rental.find({ status: { $in: ['RESERVED', 'ACTIVE', 'COMPLETED'] }, startDate: { $lt: toDate(next) } })
          .populate('vehicle', POPULATE.vehicle)
          .populate('renter', POPULATE.renter)
          .lean()
      ]);
      return {
        month: value,
        today,
        days: daysBetween(first, next),
        vehicles: vehicles.map((v) => ({ ...vehicleRef(v), status: v.status })),
        rentals: rentals.filter((r) => heldUntil(r, today) > first).map((r) => presentRental(r, ctx))
      };
    }
  };
}

module.exports = { createRentals, bookWithin, bookClassWithin, bookingDays, findOverlap, classAvailability };
