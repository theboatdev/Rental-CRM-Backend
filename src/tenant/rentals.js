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
  DateStringSchema,
  IdSchema,
  activeListKey,
  can,
  moduleOn
} = require('./common');
const { presentRental, presentPayment, vehicleRef } = require('./presenters');
const { recordPaymentIn } = require('./payments');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields } = require('./fields');
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

const ReturnSchema = (ctx) => z.strictObject({ ...InspectionSchema(ctx).shape, odometer: z.number().int().min(0) });

const ReservationSchema = (ctx, config = ctx.config) =>
  z.strictObject({
    vehicleId: IdSchema,
    renterId: IdSchema,
    startDate: DateStringSchema,
    endDate: DateStringSchema,
    dailyRate: z.number().positive().optional(),
    depositAmount: z.number().min(0).optional(),
    // An advance collected with the booking (needs payments:record).
    advance: z
      .strictObject({
        amount: z.number().positive(),
        method: activeListKey(config, 'paymentMethods'),
        transactionReference: z.string().trim().max(80).optional(),
        notes: z.string().trim().max(500).optional(),
        customFields: customFieldsInput(config, 'payments')
      })
      .optional(),
    notes: z.string().trim().max(1000).default(''),
    customFields: customFieldsInput(config, 'rentals'),
    // Hand the vehicle over straight away (needs rentals:checkin): booking and check-in in one step.
    pickup: InspectionSchema(ctx).optional()
  });

/** Notes and custom fields stay editable whatever the rental's status; dates and amounts don't change here. */
const RentalUpdateSchema = (config) =>
  z.strictObject({ notes: z.string().trim().max(1000).optional(), customFields: customFieldsInput(config, 'rentals', { update: true }) });

const AvailabilityQuerySchema = z.strictObject({ startDate: DateStringSchema, endDate: DateStringSchema, excludeRentalId: IdSchema.optional() });

const POPULATE = { vehicle: 'plateNumber make model', renter: 'profileId fullName phone' };

/** The first day a rental no longer holds its vehicle. An active rental holds it until it's returned, even past its end date. */
function heldUntil(rental, today) {
  const end = dateString(rental.endDate);
  return rental.status === 'ACTIVE' && end <= today ? addDays(today, 1) : end;
}

const describeBooking = (rental, today) => `${rental.code} (${dateString(rental.startDate)} to ${heldUntil(rental, today)})`;

/** The first reservation or active rental of the vehicle that overlaps [startDate, endDate). */
async function findOverlap(ctx, { vehicleId, startDate, endDate, excludeId, session }) {
  const today = todayIn(ctx.timezone);
  const candidates = await ctx.models.Rental.find({
    vehicle: vehicleId,
    status: { $in: ['RESERVED', 'ACTIVE'] },
    startDate: { $lt: toDate(endDate) },
    ...(excludeId ? { _id: { $ne: excludeId } } : {})
  })
    .session(session ?? null)
    .lean();
  return candidates.find((rental) => heldUntil(rental, today) > startDate) ?? null;
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

/** A booking's length in days, after checking its dates against the tenant's rules. */
function bookingDays(ctx, { startDate, endDate }) {
  const totalDays = daysBetween(startDate, endDate);
  const minDays = Math.max(1, ctx.config.rules.minRentalDays);
  if (totalDays < 1) throw invalid('The return date must be after the pickup date', [{ path: 'endDate', message: 'Before the pickup date' }]);
  if (totalDays < minDays) throw invalid(`Rentals are at least ${minDays} days`, [{ path: 'endDate', message: `At least ${minDays} days` }]);
  if (startDate < todayIn(ctx.timezone)) throw invalid('The pickup date is in the past', [{ path: 'startDate', message: 'In the past' }]);
  return totalDays;
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

  const dailyRate = data.dailyRate ?? vehicle.dailyRate;
  const depositAmount = data.depositAmount ?? vehicle.depositAmount;
  const code = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.booking, sequence: 'booking', year: today.slice(0, 4), session });
  const [created] = await ctx.models.Rental.create(
    [
      {
        code,
        renter: renter._id,
        vehicle: vehicle._id,
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
  return { rental: created.toObject(), vehicle, renter };
}

function createRentals({ platformDb }) {
  const refreshStorage = (ctx) => refreshStorageUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, models: ctx.models });

  /** Inside a transaction: checks a RESERVED rental in, renting its vehicle out. */
  async function checkInWithin(ctx, session, rental, input) {
    const today = todayIn(ctx.timezone);
    if (rental.status !== 'RESERVED') throw conflict(`${rental.code} isn't waiting for pickup any more`);
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
    const code = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.rental, sequence: 'rental', year: today.slice(0, 4), session });
    await ctx.models.Rental.updateOne(
      { _id: rental._id, status: 'RESERVED' },
      { $set: { status: 'ACTIVE', code, bookingCode: rental.code, startMileage: odometer, pickupInspection } },
      { session }
    );
    await ctx.models.Vehicle.updateOne({ _id: vehicle._id }, { $set: { status: 'RENTED', mileage: odometer } }, { session });
    return { code, plateNumber: vehicle.plateNumber, photos: hasPhotos(pickupInspection) };
  }

  async function getRental(ctx, rentalId) {
    const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { populate: POPULATE });
    const showPayments = can(ctx, 'payments:read') && moduleOn(ctx, 'payments');
    const payments = showPayments
      ? await ctx.models.Payment.find({ rental: rental._id }).sort({ paidAt: -1 }).lean()
      : null;
    return {
      ...presentRental(rental, ctx),
      payments: payments && payments.map((p) => presentPayment({ ...p, rental, renter: rental.renter }))
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
     * Books a vehicle for a renter. The rate and deposit default to the
     * vehicle's. Optionally records an advance and hands the vehicle over at
     * once, all in one transaction.
     */
    async reserve(ctx, input) {
      const data = parseRecord(ReservationSchema(ctx), input, ctx.config, 'rentals', { nested: { advance: 'payments' } });
      if (data.pickup && !can(ctx, 'rentals:checkin')) throw forbidden("You don't have the rentals:checkin permission");
      if (data.advance && !(moduleOn(ctx, 'payments') && can(ctx, 'payments:record'))) throw forbidden("You don't have the payments:record permission");
      bookingDays(ctx, data);

      let rentalId;
      let summary;
      let photos = false;
      await inTransaction(ctx, async (session) => {
        const booked = await bookWithin(ctx, session, data);
        let { rental } = booked;
        if (data.advance && data.advance.amount > rental.totalAmount + rental.depositAmount) {
          throw invalid('The advance is more than the rental and deposit together', [{ path: 'advance.amount', message: 'More than is owed' }]);
        }
        rentalId = rental._id;
        summary = `Booked ${booked.vehicle.plateNumber} for ${booked.renter.fullName} as ${rental.code}, ${data.startDate} to ${data.endDate}`;
        if (data.advance) {
          await recordPaymentIn(ctx, session, rental, { type: 'ADVANCE', ...data.advance });
          rental = { ...rental, paidAmount: data.advance.amount };
        }
        if (data.pickup) {
          const handedOver = await checkInWithin(ctx, session, rental, data.pickup);
          photos = handedOver.photos;
          summary += `; handed over as ${handedOver.code}`;
        }
      });
      if (photos) await refreshStorage(ctx);
      await recordAudit(ctx, { action: data.pickup ? 'rental.dispatched' : 'rental.reserved', entityType: 'rental', entityId: String(rentalId), summary });
      return getRental(ctx, String(rentalId));
    },

    async checkIn(ctx, rentalId, input) {
      const data = parse(InspectionSchema(ctx), input);
      let result;
      await inTransaction(ctx, async (session) => {
        const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', { session });
        result = { ...(await checkInWithin(ctx, session, rental, data)), bookingCode: rental.code };
      });
      if (result.photos) await refreshStorage(ctx);
      await recordAudit(ctx, {
        action: 'rental.checked_in',
        entityType: 'rental',
        entityId: rentalId,
        summary: `Handed over ${result.plateNumber}: ${result.bookingCode} is now ${result.code}`
      });
      return getRental(ctx, rentalId);
    },

    async updateRental(ctx, rentalId, input) {
      const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental');
      const { customFields, ...changes } = parseRecord(RentalUpdateSchema(ctx.config), input, ctx.config, 'rentals', { update: true });
      await ctx.models.Rental.updateOne({ _id: rental._id }, updateWithCustomFields(changes, customFields));
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

    /** For each vehicle, whether it can be booked for [startDate, endDate), and why not. */
    async availability(ctx, query) {
      const { startDate, endDate, excludeRentalId } = parse(AvailabilityQuerySchema, query);
      if (daysBetween(startDate, endDate) < 1) throw invalid('The return date must be after the pickup date', [{ path: 'endDate', message: 'Before the pickup date' }]);
      const today = todayIn(ctx.timezone);
      const vehicles = await ctx.models.Vehicle.find().sort({ plateNumber: 1 }).lean();
      return Promise.all(
        vehicles.map(async (vehicle) => {
          const overlap =
            vehicle.status === 'MAINTENANCE' ? null : await findOverlap(ctx, { vehicleId: vehicle._id, startDate, endDate, excludeId: excludeRentalId });
          const reason = vehicle.status === 'MAINTENANCE' ? 'In maintenance' : overlap ? `Booked: ${describeBooking(overlap, today)}` : null;
          return { vehicle: vehicleRef(vehicle), dailyRate: vehicle.dailyRate, depositAmount: vehicle.depositAmount, available: !reason, reason };
        })
      );
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

module.exports = { createRentals, bookWithin, bookingDays, findOverlap };
