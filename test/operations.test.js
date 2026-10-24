const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTenantRouter } = require('../src/routes/tenant');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createPlatformService } = require('../src/platform/service');
const { forbidden, unauthenticated } = require('../src/platform/errors');
const { todayIn, addDays, toDate } = require('../src/tenant/common');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

// Tenant A: Sri Lanka template (LKR, Asia/Colombo, every module on, CL- renter codes,
// pickup and drop inspections required). Tenant B: base template, for isolation.
const ORG_A = orgIdFor('colombo-cars');
const ORG_B = orgIdFor('other-rentals');
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const TODAY = todayIn('Asia/Colombo');
const YEAR = TODAY.slice(0, 4);

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: req.get('x-test-org') ?? ORG_A };
  next();
}

let db;
let service;
let tenantA;
let tenantB;
let points;
let server;
let baseUrl;

const as = (user, org = ORG_A) => async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-org': org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const owner = as('user_owner');
const manager = as('user_manager');
const staff = as('user_staff');
const accountant = as('user_accountant');

const modelsA = () => db.getTenantDb(tenantA.dbName).models;

async function publish(tenant, change) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  change(config);
  await service.publishConfig(tenant.id, { config, note: 'Test change', baseVersion: active.version }, ADMIN);
}

let plates = 1000;
async function addVehicle(overrides = {}) {
  const res = await owner('POST', '/vehicles', { plateNumber: `wp cab-${plates++}`, make: 'Toyota', model: 'Axio', year: 2021, dailyRate: 10000, depositAmount: 20000, mileage: 50000, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function addRenter(overrides = {}) {
  const res = await staff('POST', '/renters', {
    fullName: 'Nimal Perera',
    phone: '+94 77 123 4567',
    residentType: 'local',
    documents: [
      { type: 'NIC', number: '198812304561', verified: true },
      { type: 'DRIVING_LICENSE_LK', number: 'B3920194', verified: true }
    ],
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function book(vehicle, renter, overrides = {}, caller = staff) {
  return caller('POST', '/rentals', { vehicleId: vehicle.id, renterId: renter.id, startDate: TODAY, endDate: addDays(TODAY, 3), ...overrides });
}

before(async () => {
  db = await startTestDb();
  const clerk = createFakeClerk();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
  const limits = { maxVehicles: 20, maxUsers: 20, storageGb: 5 };
  ({ tenant: tenantA } = await service.createTenant({ name: 'Colombo Cars', slug: 'colombo-cars', template: 'sri-lanka', adminEmail: 'a@colombo.example', limits }, ADMIN));
  ({ tenant: tenantB } = await service.createTenant({ name: 'Other Rentals', slug: 'other-rentals', template: 'base', adminEmail: 'b@other.example', limits }, ADMIN));
  points = (await service.getActiveConfig(tenantA.id)).config.modules.rentals.inspectionPoints;

  const { Member } = modelsA();
  for (const [clerkUserId, roleKey] of [['user_owner', 'owner'], ['user_manager', 'manager'], ['user_staff', 'staff'], ['user_accountant', 'accountant']]) {
    await Member.create({ clerkUserId, email: `${clerkUserId}@colombo.example`, name: clerkUserId.replace('user_', ''), roleKey });
  }
  await db.getTenantDb(tenantB.dbName).models.Member.create({ clerkUserId: 'user_b_owner', email: 'b@other.example', roleKey: 'owner' });

  const router = createTenantRouter({ tenantAuth: stubTenantAuth, platformDb: db.platformDb, getTenantDb: db.getTenantDb, directory: service, clerk, cacheTtlMs: 0 });
  server = express().use(express.json()).use('/api/v1', router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('vehicles', () => {
  it('adds a vehicle with the plan limit, a unique plate and the default deposit', async () => {
    const { status, body } = await owner('POST', '/vehicles', { plateNumber: 'wp cba-7706', make: 'Toyota', model: 'Raize', year: 2025, dailyRate: 22500 });
    assert.equal(status, 201);
    assert.equal(body.plateNumber, 'WP CBA-7706');
    assert.equal(body.depositAmount, 25000); // rules.defaultDepositAmount of the Sri Lanka template
    assert.equal(body.status, 'AVAILABLE');
    assert.equal((await db.platformDb.models.Tenant.findById(tenantA.id).lean()).usage.vehicles, 1);

    assert.equal((await owner('POST', '/vehicles', { plateNumber: 'WP CBA-7706', make: 'X', model: 'Y', year: 2020, dailyRate: 1 })).status, 409);
    const bad = await owner('POST', '/vehicles', { plateNumber: 'WP X-1', model: 'Y', year: 2020, dailyRate: 1, thumbnail: 'http://insecure.example/car.jpg' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.error.issues.map((i) => i.path).sort(), ['make', 'thumbnail']);
    assert.equal((await staff('POST', '/vehicles', { plateNumber: 'WP X-2', make: 'X', model: 'Y', year: 2020, dailyRate: 1 })).status, 403);
  });

  it('refuses vehicles beyond limits.maxVehicles', async () => {
    const count = (await owner('GET', '/vehicles')).body.length;
    await publish(tenantA, (config) => (config.limits.maxVehicles = count));
    try {
      const full = await owner('POST', '/vehicles', { plateNumber: 'WP FULL-1', make: 'X', model: 'Y', year: 2020, dailyRate: 1 });
      assert.equal(full.status, 409);
      assert.match(full.body.error.message, new RegExp(`allows ${count} vehicles`));
    } finally {
      await publish(tenantA, (config) => (config.limits.maxVehicles = 20));
    }
  });

  it('switches maintenance on and off, but never by hand to RENTED', async () => {
    const vehicle = await addVehicle();
    assert.equal((await staff('PATCH', `/vehicles/${vehicle.id}`, { status: 'MAINTENANCE', mileage: 50500 })).body.status, 'MAINTENANCE');
    assert.equal((await staff('PATCH', `/vehicles/${vehicle.id}`, { status: 'RENTED' })).status, 422);
    assert.equal((await staff('PATCH', `/vehicles/${vehicle.id}`, { status: 'AVAILABLE' })).body.mileage, 50500);
  });

  it('deletes only vehicles without history', async () => {
    const unused = await addVehicle();
    assert.deepEqual((await owner('DELETE', `/vehicles/${unused.id}`)).body, { id: unused.id, deleted: true });
    const used = await addVehicle();
    await owner('POST', '/costs', { vehicleId: used.id, category: 'TIRE_REPLACEMENT', title: 'Four tyres', amount: 80000 });
    assert.equal((await owner('DELETE', `/vehicles/${used.id}`)).status, 409);
  });
});

describe('renters', () => {
  it('numbers profiles with the tenant prefix and reports compliance gaps', async () => {
    const local = await addRenter();
    assert.match(local.profileId, /^CL-\d{4}$/);
    assert.deepEqual(local.compliance, { ok: true, missingDocuments: [], needsPermit: false, unverified: [] });
    assert.equal(local.documents[0].verifiedBy.id, 'user_staff');

    const tourist = await addRenter({ fullName: 'David Miller', residentType: 'tourist', country: 'United Kingdom', documents: [{ type: 'PASSPORT', number: 'GB9821034' }] });
    assert.equal(Number(tourist.profileId.slice(3)), Number(local.profileId.slice(3)) + 1);
    assert.equal(tourist.compliance.ok, false);
    assert.equal(tourist.compliance.needsPermit, true);
    assert.deepEqual(tourist.compliance.unverified, ['PASSPORT']);

    const added = await staff('POST', `/renters/${tourist.id}/documents`, { type: 'DMT_PERMIT', number: 'DMT-BIA-2026-491' });
    assert.equal(added.body.compliance.ok, true);
    const passport = added.body.documents.find((d) => d.type === 'PASSPORT');
    const verified = await staff('POST', `/renters/${tourist.id}/documents/${passport.id}/verify`);
    assert.equal(verified.body.documents.find((d) => d.type === 'PASSPORT').verified, true);
  });

  it('rejects unknown document types and verifying without renters:documents:verify', async () => {
    const unknown = await staff('POST', '/renters', { fullName: 'X Y', phone: '+94 70 000 0000', documents: [{ type: 'LIBRARY_CARD', number: '1' }] });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.issues[0].path, 'documents[0].type');

    await owner('POST', '/roles', { key: 'intake', name: 'Intake', permissions: ['renters:read', 'renters:create', 'renters:update'] });
    await modelsA().Member.create({ clerkUserId: 'user_intake', email: 'intake@colombo.example', roleKey: 'intake' });
    const intake = as('user_intake');
    const doc = { type: 'NIC', number: '199578102391' };
    assert.equal((await intake('POST', '/renters', { fullName: 'Kavindi W', phone: '+94 71 889 9234', documents: [{ ...doc, verified: true }] })).status, 403);
    const created = await intake('POST', '/renters', { fullName: 'Kavindi W', phone: '+94 71 889 9234', documents: [doc] });
    assert.equal(created.status, 201);
    assert.equal((await intake('POST', `/renters/${created.body.id}/documents/${created.body.documents[0].id}/verify`)).status, 403);
  });
});

describe('bookings', () => {
  it('reserves without renting the vehicle out, recording the advance once', async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    const { status, body } = await book(vehicle, renter, { advance: { amount: 25, method: 'CASH' } });
    assert.equal(status, 201);
    assert.match(body.code, new RegExp(`^BK-${YEAR}-\\d{4}$`));
    assert.equal(body.status, 'RESERVED');
    assert.equal(body.totalDays, 3);
    assert.equal(body.totalAmount, 300);
    assert.equal(body.paidAmount, 25);
    assert.equal(body.balance, 325);
    assert.equal(body.payments.length, 1);
    assert.match(body.payments[0].receiptNumber, new RegExp(`^ADV-${YEAR}-\\d{4}$`));
    assert.equal((await staff('GET', `/vehicles/${vehicle.id}`)).body.status, 'AVAILABLE');
  });

  it('rejects overlapping bookings but allows back-to-back ones', async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    assert.equal((await book(vehicle, renter)).status, 201);
    const overlap = await book(vehicle, renter, { startDate: addDays(TODAY, 2), endDate: addDays(TODAY, 5) });
    assert.equal(overlap.status, 409);
    assert.match(overlap.body.error.message, /^Conflicts with BK-/);
    assert.equal((await book(vehicle, renter, { startDate: addDays(TODAY, 3), endDate: addDays(TODAY, 4) })).status, 201);

    const availability = (await staff('GET', `/vehicles/availability?startDate=${TODAY}&endDate=${addDays(TODAY, 1)}`)).body;
    assert.equal(availability.find((a) => a.vehicle.id === vehicle.id).available, false);
  });

  it('rejects maintenance vehicles, bad dates, short rentals and oversized advances', async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    assert.equal((await book(vehicle, renter, { endDate: TODAY })).status, 422);
    assert.equal((await book(vehicle, renter, { startDate: addDays(TODAY, -1) })).body.error.issues[0].path, 'startDate');
    assert.equal((await book(vehicle, renter, { advance: { amount: 351, method: 'CASH' } })).status, 422);
    assert.equal((await book(vehicle, renter, { advance: { amount: 10, method: 'ONLINE' } })).status, 422); // inactive method
    await publish(tenantA, (config) => (config.rules.minRentalDays = 5));
    try {
      assert.match((await book(vehicle, renter)).body.error.message, /at least 5 days/);
    } finally {
      await publish(tenantA, (config) => (config.rules.minRentalDays = 1));
    }
    await staff('PATCH', `/vehicles/${vehicle.id}`, { status: 'MAINTENANCE' });
    assert.match((await book(vehicle, renter)).body.error.message, /maintenance/);
  });

  it('lets only one of two simultaneous bookings take the same days', async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    const results = await Promise.all([book(vehicle, renter), book(vehicle, renter)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });

  it('checks in within the booking dates, after a full inspection, renting the vehicle out', async () => {
    const vehicle = await addVehicle({ mileage: 123 });
    const renter = await addRenter();
    const future = (await book(vehicle, renter, { startDate: addDays(TODAY, 5), endDate: addDays(TODAY, 8) })).body;
    assert.match((await staff('POST', `/rentals/${future.id}/check-in`, { checkedPoints: points })).body.error.message, /can only be checked in from/);

    const booking = (await book(vehicle, renter)).body;
    const partial = await staff('POST', `/rentals/${booking.id}/check-in`, { checkedPoints: points.slice(1) });
    assert.equal(partial.status, 422);
    assert.match(partial.body.error.message, new RegExp(points[0].replace(/[&]/g, '\\$&')));
    assert.equal((await staff('POST', `/rentals/${booking.id}/check-in`, { checkedPoints: points, odometer: 100 })).status, 422);

    const { status, body } = await staff('POST', `/rentals/${booking.id}/check-in`, { checkedPoints: points, notes: 'Clean' });
    assert.equal(status, 200);
    assert.equal(body.status, 'ACTIVE');
    assert.match(body.code, new RegExp(`^RNT-${YEAR}-\\d{4}$`));
    assert.equal(body.bookingCode, booking.code);
    assert.equal(body.startMileage, 123);
    assert.deepEqual(body.pickupInspection.points, points);
    assert.equal((await staff('GET', `/vehicles/${vehicle.id}`)).body.status, 'RENTED');
    assert.equal((await staff('POST', `/rentals/${booking.id}/check-in`, { checkedPoints: points })).status, 409);
  });

  it("won't hand over a vehicle that is still out", async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    const booking = (await book(vehicle, renter)).body;
    await modelsA().Vehicle.updateOne({ _id: vehicle.id }, { $set: { status: 'RENTED' } });
    assert.match((await staff('POST', `/rentals/${booking.id}/check-in`, { checkedPoints: points })).body.error.message, /still out/);
  });

  it('dispatches straight away: booking and check-in in one step', async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    const { status, body } = await book(vehicle, renter, { pickup: { checkedPoints: points } });
    assert.equal(status, 201);
    assert.equal(body.status, 'ACTIVE');
    assert.match(body.bookingCode, /^BK-/);
    // Without rentals:checkin, the immediate hand-over is refused and nothing is booked.
    await owner('POST', '/roles', { key: 'booker', name: 'Booker', permissions: ['rentals:read', 'rentals:create', 'vehicles:read', 'renters:read'] });
    await modelsA().Member.create({ clerkUserId: 'user_booker', email: 'booker@colombo.example', roleKey: 'booker' });
    const other = await addVehicle();
    assert.equal((await book(other, renter, { pickup: { checkedPoints: points } }, as('user_booker'))).status, 403);
    assert.equal((await staff('GET', `/rentals?vehicleId=${other.id}`)).body.length, 0);
  });

  it('records the return: odometer, drop inspection, vehicle available again', async () => {
    const vehicle = await addVehicle({ mileage: 1000 });
    const renter = await addRenter();
    const rental = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    assert.equal((await staff('POST', `/rentals/${rental.id}/return`, { odometer: 900, checkedPoints: points })).status, 422);
    assert.equal((await staff('POST', `/rentals/${rental.id}/return`, { odometer: 1650 })).status, 422); // drop inspection required

    const { body } = await staff('POST', `/rentals/${rental.id}/return`, { odometer: 1650, checkedPoints: points });
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.distance, 650);
    assert.ok(body.actualReturnDate);
    const after = (await staff('GET', `/vehicles/${vehicle.id}`)).body;
    assert.equal(after.status, 'AVAILABLE');
    assert.equal(after.mileage, 1650);
  });

  it('cancels reservations only, releasing the dates and keeping advances in the ledger', async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    const booking = (await book(vehicle, renter, { advance: { amount: 25, method: 'CASH' } })).body;
    const cancelled = (await staff('POST', `/rentals/${booking.id}/cancel`)).body;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.paidAmount, 25);
    assert.equal((await staff('POST', `/rentals/${booking.id}/cancel`)).status, 409);
    assert.equal((await book(vehicle, renter)).status, 201);
  });

  it('keeps an overdue rental holding its vehicle until it is returned', async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    const { Rental, Vehicle } = modelsA();
    await Rental.create({
      code: 'RNT-OLD-0001',
      renter: renter.id,
      vehicle: vehicle.id,
      status: 'ACTIVE',
      startDate: toDate(addDays(TODAY, -5)),
      endDate: toDate(addDays(TODAY, -1)),
      totalDays: 4,
      dailyRate: 1,
      totalAmount: 4,
      depositAmount: 0,
      startMileage: 50000
    });
    await Vehicle.updateOne({ _id: vehicle.id }, { $set: { status: 'RENTED' } });
    const blocked = await book(vehicle, renter, { startDate: TODAY, endDate: addDays(TODAY, 2) });
    assert.match(blocked.body.error.message, /RNT-OLD-0001/);
    const overdue = (await staff('GET', `/rentals?status=ACTIVE&vehicleId=${vehicle.id}`)).body[0];
    assert.equal(overdue.overdue, true);
  });

  it('shows a month of the fleet schedule', async () => {
    const { status, body } = await staff('GET', `/calendar?month=${TODAY.slice(0, 7)}`);
    assert.equal(status, 200);
    assert.equal(body.today, TODAY);
    assert.ok(body.vehicles.length > 0);
    assert.ok(body.rentals.every((r) => ['RESERVED', 'ACTIVE', 'COMPLETED'].includes(r.status)));
    assert.equal((await staff('GET', '/calendar?month=2026-13')).status, 422);
  });
});

describe('payments', () => {
  it('records payments with receipt numbers and keeps the paid amount in step', async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    const rental = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    const paid = await staff('POST', '/payments', { rentalId: rental.id, type: 'RENTAL', method: 'BANK_TRANSFER', amount: 300, transactionReference: 'SLIP-1' });
    assert.equal(paid.status, 201);
    assert.match(paid.body.receiptNumber, new RegExp(`^RCPT-${YEAR}-\\d{4}$`));
    assert.equal(paid.body.rental.code, rental.code);
    assert.equal((await staff('GET', `/rentals/${rental.id}`)).body.paidAmount, 300);
    assert.equal((await staff('POST', '/payments', { rentalId: rental.id, type: 'RENTAL', method: 'BITCOIN', amount: 1 })).status, 422);
  });

  it("refuses more than is owed on a reservation, and refunds beyond what was paid", async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    const booking = (await book(vehicle, renter)).body;
    assert.equal((await staff('POST', '/payments', { rentalId: booking.id, type: 'ADVANCE', method: 'CASH', amount: 351 })).status, 422);
    await staff('POST', '/payments', { rentalId: booking.id, type: 'ADVANCE', method: 'CASH', amount: 100 });
    await staff('POST', `/rentals/${booking.id}/cancel`);
    assert.equal((await staff('POST', '/payments', { rentalId: booking.id, type: 'RENTAL', method: 'CASH', amount: 10 })).status, 409);
    assert.equal((await staff('POST', '/payments', { rentalId: booking.id, type: 'REFUND', method: 'CASH', amount: 101 })).status, 422);
    assert.equal((await staff('POST', '/payments', { rentalId: booking.id, type: 'REFUND', method: 'CASH', amount: 100 })).status, 201);
    assert.equal((await staff('GET', `/rentals/${booking.id}`)).body.paidAmount, 0);
  });

  it('voids entries with a reason (payments:void), taking them back out', async () => {
    const vehicle = await addVehicle({ dailyRate: 100, depositAmount: 50 });
    const renter = await addRenter();
    const rental = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    const payment = (await staff('POST', '/payments', { rentalId: rental.id, type: 'RENTAL', method: 'CASH', amount: 120 })).body;
    assert.equal((await staff('POST', `/payments/${payment.id}/void`, { reason: 'Typo' })).status, 403);
    assert.equal((await manager('POST', `/payments/${payment.id}/void`, {})).status, 422);
    const voided = await manager('POST', `/payments/${payment.id}/void`, { reason: 'Entered twice' });
    assert.equal(voided.body.voided, true);
    assert.equal(voided.body.voidedBy.id, 'user_manager');
    assert.equal((await staff('GET', `/rentals/${rental.id}`)).body.paidAmount, 0);
    assert.equal((await accountant('POST', `/payments/${payment.id}/void`, { reason: 'Again' })).status, 409);
  });
});

describe('costs and fuel', () => {
  it('logs costs against list categories and moves the odometer forward', async () => {
    const vehicle = await addVehicle({ mileage: 40000 });
    const cost = await staff('POST', '/costs', { vehicleId: vehicle.id, category: 'ROUTINE_MAINTENANCE', title: '40,000 km service', amount: 24500, odometer: 40200, serviceCenter: 'Toyota Lanka' });
    assert.equal(cost.status, 201);
    assert.equal(cost.body.incurredAt, TODAY);
    assert.equal((await staff('GET', `/vehicles/${vehicle.id}`)).body.mileage, 40200);
    assert.equal((await staff('POST', '/costs', { vehicleId: vehicle.id, category: 'SPA_DAY', title: 'Nope', amount: 1 })).status, 422);
    assert.equal((await staff('DELETE', `/costs/${cost.body.id}`)).status, 403);
    assert.equal((await manager('DELETE', `/costs/${cost.body.id}`)).status, 200);
  });

  it('works out the fuel total or price, and hides fuel when the module is off', async () => {
    const vehicle = await addVehicle();
    const log = await staff('POST', '/fuel-logs', { vehicleId: vehicle.id, liters: 36, pricePerLiter: 414 });
    assert.equal(log.body.totalCost, 14904);
    assert.equal((await staff('POST', '/fuel-logs', { vehicleId: vehicle.id, liters: 30, totalCost: 12000 })).body.pricePerLiter, 400);
    assert.equal((await staff('POST', '/fuel-logs', { vehicleId: vehicle.id, liters: 30 })).status, 422);

    await publish(tenantA, (config) => (config.modules.fuelLogs.enabled = false));
    try {
      assert.equal((await staff('GET', '/fuel-logs')).status, 404);
      assert.equal((await owner('GET', '/vehicles')).body[0].stats.fuelLiters, undefined);
    } finally {
      await publish(tenantA, (config) => (config.modules.fuelLogs.enabled = true));
    }
  });
});

describe('dashboard and WhatsApp digest', () => {
  it('shows owners the financial picture and per-vehicle figures', async () => {
    const { status, body } = await owner('GET', '/dashboard?range=all');
    assert.equal(status, 200);
    assert.equal(body.fleet.total, body.vehicles.length);
    assert.equal(body.fleet.rented + body.fleet.available + body.fleet.maintenance, body.fleet.total);
    const sum = (key) => body.vehicles.reduce((total, v) => total + v[key], 0);
    assert.equal(body.totals.revenue, sum('revenue'));
    assert.equal(body.totals.profit, body.totals.revenue - body.totals.operatingCosts);
    assert.ok(body.totals.revenue > 0);
    assert.ok(body.alerts.some((a) => a.kind === 'overdue'));
    assert.equal((await owner('GET', '/dashboard?range=1y')).status, 422);
  });

  it('hides revenue, costs totals and profit from staff without financials:view', async () => {
    const { body } = await staff('GET', '/dashboard?range=all');
    for (const key of ['revenue', 'operatingCosts', 'profit', 'profitMargin']) {
      assert.equal(key in body.totals, false, key);
      assert.ok(body.vehicles.every((v) => !(key in v)), key);
    }
    assert.ok('serviceCosts' in body.totals); // staff has costs:read
    assert.ok(body.fleet.total > 0);
    assert.ok((await staff('GET', '/vehicles')).body.every((v) => !('profit' in v.stats) && 'trips' in v.stats));
  });

  it('builds the digest text, with money lines only for financials:view', async () => {
    const full = (await manager('GET', '/whatsapp/digest')).body;
    assert.equal(full.includesFinancials, true);
    assert.match(full.message, /COLOMBO CARS — WEEKLY FLEET DIGEST/);
    assert.match(full.message, /Collected: /);
    assert.match(full.message, /ACTION ITEMS/);

    await owner('POST', '/roles', { key: 'digest_reader', name: 'Digest reader', permissions: ['whatsapp:view'] });
    await modelsA().Member.create({ clerkUserId: 'user_digest', email: 'digest@colombo.example', roleKey: 'digest_reader' });
    const limited = (await as('user_digest')('GET', '/whatsapp/digest')).body;
    assert.equal(limited.includesFinancials, false);
    assert.doesNotMatch(limited.message, /Collected/);
    assert.equal((await staff('GET', '/whatsapp/digest')).status, 403);
  });
});

describe('tenant isolation', () => {
  it("never shows one tenant's rentals to another", async () => {
    const vehicle = await addVehicle();
    const renter = await addRenter();
    const rental = (await book(vehicle, renter)).body;
    const other = as('user_b_owner', ORG_B);
    assert.equal((await other('GET', `/rentals/${rental.id}`)).status, 404);
    assert.equal((await other('POST', `/rentals/${rental.id}/cancel`)).status, 404);
    assert.deepEqual((await other('GET', '/rentals')).body, []);
    assert.equal((await other('POST', '/rentals', { vehicleId: vehicle.id, renterId: renter.id, startDate: TODAY, endDate: addDays(TODAY, 2) })).status, 404);
  });
});
