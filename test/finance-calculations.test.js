/**
 * Finance calculation coverage for production safety:
 * - default totalAmount = totalDays × dailyRate
 * - billableDays override (lower / higher / clear)
 * - date change resets billableDays
 * - paid-amount guard when reducing the total
 * - ACTIVE rentals can edit billableDays
 * - third-party supplierRentalCost + vehicle gross/net profit stats
 * - balance / outstanding after billable changes
 *
 * Run locally (no git push):
 *   node --test test/finance-calculations.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTenantRouter } = require('../src/routes/tenant');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createPlatformService } = require('../src/platform/service');
const { unauthenticated } = require('../src/platform/errors');
const { todayIn, addDays } = require('../src/tenant/common');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

const ORG = orgIdFor('finance-cars');
const ADMIN = { id: 'user_fin_admin', name: 'Finance Admin' };
const TODAY = todayIn('Asia/Colombo');

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: req.get('x-test-org') ?? ORG };
  next();
}

let db;
let service;
let tenant;
let points;
let server;
let baseUrl;
let plates = 5000;

const as = (user) => async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-org': ORG },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.headers.get('content-type') === 'application/pdf') {
    return { status: res.status, headers: res.headers, pdf: Buffer.from(await res.arrayBuffer()) };
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const owner = as('user_owner');
const staff = as('user_staff');

async function publish(change) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  change(config);
  await service.publishConfig(tenant.id, { config, note: 'Finance test change', baseVersion: active.version }, ADMIN);
}

async function addVehicle(overrides = {}) {
  const res = await owner('POST', '/vehicles', {
    plateNumber: `wp fin-${plates++}`,
    make: 'Toyota',
    model: 'Axio',
    year: 2021,
    dailyRate: 10000,
    depositAmount: 20000,
    mileage: 50000,
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function addRenter(overrides = {}) {
  const res = await staff('POST', '/renters', {
    fullName: 'Finance Tester',
    phone: `+94 77 ${String(plates).slice(-7)}`,
    residentType: 'local',
    documents: [
      { type: 'NIC', number: `1988${plates}`, verified: true },
      { type: 'DRIVING_LICENSE_LK', number: `B${plates}`, verified: true }
    ],
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** Default book: TODAY → TODAY+3 = 4 inclusive calendar days. */
async function book(vehicle, renter, overrides = {}) {
  return staff('POST', '/rentals', {
    vehicleId: vehicle.id,
    renterId: renter.id,
    startDate: TODAY,
    endDate: addDays(TODAY, 3),
    ...overrides
  });
}

async function getRental(id) {
  const res = await staff('GET', `/rentals/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  db = await startTestDb();
  const clerk = createFakeClerk();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
  ({ tenant } = await service.createTenant(
    {
      name: 'Finance Cars',
      slug: 'finance-cars',
      template: 'sri-lanka',
      adminEmail: 'finance@example.com',
      limits: { maxVehicles: 100, maxUsers: 20, storageGb: 5 }
    },
    ADMIN
  ));
  points = (await service.getActiveConfig(tenant.id)).config.modules.rentals.inspectionPoints;

  const { Member } = db.getTenantDb(tenant.dbName).models;
  for (const [clerkUserId, roleKey] of [
    ['user_owner', 'owner'],
    ['user_staff', 'staff']
  ]) {
    await Member.create({ clerkUserId, email: `${clerkUserId}@finance.example`, name: clerkUserId.replace('user_', ''), roleKey });
  }

  const router = createTenantRouter({
    tenantAuth: stubTenantAuth,
    platformDb: db.platformDb,
    getTenantDb: db.getTenantDb,
    directory: service,
    clerk,
    cacheTtlMs: 0
  });
  server = express().use(express.json()).use('/api/v1', router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('default booking totals', () => {
  it('sets totalAmount = totalDays × dailyRate and billableDays null', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 20000 });
    const renter = await addRenter();
    const { status, body } = await book(vehicle, renter);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.totalDays, 4);
    assert.equal(body.billableDays, null);
    assert.equal(body.dailyRate, 10000);
    assert.equal(body.totalAmount, 40000);
    // Outstanding = rental + deposit − paid
    assert.equal(body.paidAmount, 0);
    assert.equal(body.balance, 60000);
  });

  it('uses a booking-level dailyRate override in the total', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 5000 });
    const renter = await addRenter();
    const { status, body } = await book(vehicle, renter, { dailyRate: 7500 });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.totalDays, 4);
    assert.equal(body.dailyRate, 7500);
    assert.equal(body.totalAmount, 30000);
    assert.equal(body.balance, 35000);
  });
});

describe('billableDays override', () => {
  it('lowers chargeable days and recalculates totalAmount without changing dates', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 20000 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    assert.equal(created.totalAmount, 40000);

    const patched = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 2 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.startDate, created.startDate);
    assert.equal(patched.body.endDate, created.endDate);
    assert.equal(patched.body.totalDays, 4);
    assert.equal(patched.body.billableDays, 2);
    assert.equal(patched.body.totalAmount, 20000);
    assert.equal(patched.body.balance, 40000); // 20000 rental + 20000 deposit
  });

  it('allows charging more days than the calendar span', async () => {
    const vehicle = await addVehicle({ dailyRate: 1000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    assert.equal(created.totalAmount, 4000);

    const patched = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 6 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.totalDays, 4);
    assert.equal(patched.body.billableDays, 6);
    assert.equal(patched.body.totalAmount, 6000);
    assert.equal(patched.body.balance, 6000);
  });

  it('clears billableDays with null and restores calendar total', async () => {
    const vehicle = await addVehicle({ dailyRate: 5000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    assert.equal((await staff('PATCH', `/rentals/${created.id}`, { billableDays: 1 })).body.totalAmount, 5000);

    const cleared = await staff('PATCH', `/rentals/${created.id}`, { billableDays: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.billableDays, null);
    assert.equal(cleared.body.totalDays, 4);
    assert.equal(cleared.body.totalAmount, 20000);
  });

  it('rejects billableDays below 1', async () => {
    const vehicle = await addVehicle({ dailyRate: 1000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    const bad = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 0 });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.issues.some((i) => i.path === 'billableDays'), JSON.stringify(bad.body));
  });

  it('recalculates total when dailyRate changes while a billableDays override is set', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    await staff('PATCH', `/rentals/${created.id}`, { billableDays: 2 });

    const patched = await staff('PATCH', `/rentals/${created.id}`, { dailyRate: 8000 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.billableDays, 2);
    assert.equal(patched.body.totalDays, 4);
    assert.equal(patched.body.dailyRate, 8000);
    // Must use billableDays (2), not totalDays (4)
    assert.equal(patched.body.totalAmount, 16000);
  });
});

describe('date change resets billableDays', () => {
  it('clears the override and recomputes from the new calendar span', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    await staff('PATCH', `/rentals/${created.id}`, { billableDays: 2 });
    assert.equal((await getRental(created.id)).totalAmount, 20000);

    const newEnd = addDays(TODAY, 1); // TODAY → +1 = 2 calendar days
    const patched = await staff('PATCH', `/rentals/${created.id}`, { endDate: newEnd });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.endDate, newEnd);
    assert.equal(patched.body.totalDays, 2);
    assert.equal(patched.body.billableDays, null);
    assert.equal(patched.body.totalAmount, 20000); // 2 × 10000
  });
});

describe('paid-amount guard', () => {
  it('refuses a billableDays cut that would put the total below amount already paid', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body; // total 40000
    const paid = await staff('POST', '/payments', {
      rentalId: created.id,
      type: 'ADVANCE',
      method: 'CASH',
      amount: 25000
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    // 1 day × 10000 = 10000 < paid 25000 → refuse
    const refused = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 1 });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /below what was already paid/i);
    assert.ok(refused.body.error.issues.some((i) => i.path === 'billableDays'));

    const still = await getRental(created.id);
    assert.equal(still.totalAmount, 40000);
    assert.equal(still.billableDays, null);
    assert.equal(still.paidAmount, 25000);
  });

  it('allows a reduction when the new total still covers what was paid', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    assert.equal((await staff('POST', '/payments', { rentalId: created.id, type: 'ADVANCE', method: 'CASH', amount: 15000 })).status, 201);

    const patched = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 2 }); // 20000 >= 15000
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.totalAmount, 20000);
    assert.equal(patched.body.paidAmount, 15000);
    assert.equal(patched.body.balance, 5000);
  });
});

describe('ACTIVE rental billableDays', () => {
  it('lets staff change chargeable days after handover', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const active = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.totalAmount, 40000);

    const patched = await staff('PATCH', `/rentals/${active.id}`, { billableDays: 3 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.status, 'ACTIVE');
    assert.equal(patched.body.billableDays, 3);
    assert.equal(patched.body.totalAmount, 30000);
    assert.equal(patched.body.totalDays, 4);
  });

  it('clears fullPayment confirmation when a billableDays raise leaves money owed', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    // Pay full calendar total then hand over with confirmFullPayment
    const booking = (await book(vehicle, renter, { advance: { amount: 40000, method: 'CASH' } })).body;
    const handed = await staff('POST', `/rentals/${booking.id}/check-in`, {
      checkedPoints: points,
      confirmFullPayment: true
    });
    assert.equal(handed.status, 200, JSON.stringify(handed.body));
    assert.ok(handed.body.fullPayment);

    const raised = await staff('PATCH', `/rentals/${handed.body.id}`, { billableDays: 5 }); // 50000 > paid 40000
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.totalAmount, 50000);
    assert.equal(raised.body.fullPayment, null);
    assert.equal(raised.body.balance, 10000);
  });
});

describe('third-party supplier costs and vehicle profit', () => {
  before(async () => {
    await publish((config) => {
      config.modules.vehicles.thirdPartyVehicles = true;
      if (!config.modules.suppliers) config.modules.suppliers = { enabled: false };
    });
  });

  it('stores supplierRentalCost on THIRD_PARTY bookings and reports gross/net on the vehicle', async () => {
    const vehicle = await addVehicle({
      dailyRate: 10000,
      depositAmount: 0,
      ownership: 'THIRD_PARTY'
    });
    assert.equal(vehicle.ownership, 'THIRD_PARTY');

    const renter = await addRenter();
    // 4 days × 10000 = 40000 revenue; supplier hire 15000
    const booked = await book(vehicle, renter, {
      supplierRentalCost: 15000,
      pickup: { checkedPoints: points }
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.totalAmount, 40000);
    assert.equal(booked.body.supplierRentalCost, 15000);

    // Complete the rental so it counts in lifetime vehicle totals
    const returned = await staff('POST', `/rentals/${booked.body.id}/return`, {
      checkedPoints: points,
      odometer: vehicle.mileage + 100
    });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));

    const dossier = await owner('GET', `/vehicles/${vehicle.id}`);
    assert.equal(dossier.status, 200, JSON.stringify(dossier.body));
    assert.equal(dossier.body.stats.revenue, 40000);
    assert.equal(dossier.body.stats.supplierCosts, 15000);
    assert.equal(dossier.body.stats.grossProfit, 25000); // revenue − supplier
    // No operating costs logged → net = gross
    assert.equal(dossier.body.stats.profit, 25000);
  });

  it('recalculates customer total from billableDays without changing supplierRentalCost', async () => {
    const vehicle = await addVehicle({
      dailyRate: 10000,
      depositAmount: 0,
      ownership: 'THIRD_PARTY'
    });
    const renter = await addRenter();
    const booked = (await book(vehicle, renter, { supplierRentalCost: 12000 })).body;
    assert.equal(booked.totalAmount, 40000);
    assert.equal(booked.supplierRentalCost, 12000);

    const patched = await staff('PATCH', `/rentals/${booked.id}`, { billableDays: 2 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.totalAmount, 20000);
    assert.equal(patched.body.supplierRentalCost, 12000);
    assert.equal(patched.body.billableDays, 2);
  });

  it('does not keep supplierRentalCost on OWNED vehicles', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0, ownership: 'OWNED' });
    const renter = await addRenter();
    const booked = await book(vehicle, renter, { supplierRentalCost: 9999 });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.supplierRentalCost, undefined);
    assert.equal(booked.body.totalAmount, 40000);
  });
});

describe('COMPLETED rentals are locked', () => {
  it('refuses billableDays edits after return', async () => {
    const vehicle = await addVehicle({ dailyRate: 1000, depositAmount: 0 });
    const renter = await addRenter();
    const active = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    assert.equal((await staff('POST', `/rentals/${active.id}/return`, { checkedPoints: points, odometer: vehicle.mileage + 10 })).status, 200);

    const refused = await staff('PATCH', `/rentals/${active.id}`, { billableDays: 1 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /completed/i);
  });
});

describe('billableDays endpoints', () => {
  it('GET /rentals/:id and GET /rentals return the stored billableDays', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    assert.equal((await staff('PATCH', `/rentals/${created.id}`, { billableDays: 2 })).status, 200);

    const detail = await staff('GET', `/rentals/${created.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.billableDays, 2);
    assert.equal(detail.body.totalDays, 4);
    assert.equal(detail.body.totalAmount, 20000);

    const list = await staff('GET', `/rentals?status=RESERVED`);
    assert.equal(list.status, 200);
    const row = list.body.find((r) => r.id === created.id);
    assert.ok(row, 'rental missing from list');
    assert.equal(row.billableDays, 2);
    assert.equal(row.totalAmount, 20000);
  });

  it('GET /rentals/:id/return-receipt succeeds when billableDays differs from totalDays', async () => {
    const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
    const renter = await addRenter();
    const active = (await book(vehicle, renter, { pickup: { checkedPoints: points } })).body;
    assert.equal((await staff('PATCH', `/rentals/${active.id}`, { billableDays: 2 })).status, 200);
    assert.equal(
      (await staff('POST', `/rentals/${active.id}/return`, { checkedPoints: points, odometer: vehicle.mileage + 25 })).status,
      200
    );

    const receipt = await staff('GET', `/rentals/${active.id}/return-receipt`);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.equal(receipt.headers.get('content-type'), 'application/pdf');
    assert.match(receipt.headers.get('content-disposition') ?? '', /return-receipt\.pdf/);
    assert.equal(receipt.pdf.subarray(0, 5).toString(), '%PDF-');
    // Endpoint renders with compress:true; content is verified via settlement totals on the rental.
    const completed = await getRental(active.id);
    assert.equal(completed.billableDays, 2);
    assert.equal(completed.totalAmount, 20000);
  });

  it('strips billableDays from staff when hideBookingPricingWithoutFinancials is on', async () => {
    await publish((config) => {
      config.modules.rentals.hideBookingPricingWithoutFinancials = true;
    });
    try {
      const vehicle = await addVehicle({ dailyRate: 10000, depositAmount: 0 });
      const renter = await addRenter();
      const created = (await book(vehicle, renter)).body;
      assert.equal((await owner('PATCH', `/rentals/${created.id}`, { billableDays: 2 })).status, 200);

      const staffView = await staff('GET', `/rentals/${created.id}`);
      assert.equal(staffView.status, 200);
      assert.equal('billableDays' in staffView.body, false);
      assert.equal('totalAmount' in staffView.body, false);
      assert.equal('dailyRate' in staffView.body, false);

      const ownerView = await owner('GET', `/rentals/${created.id}`);
      assert.equal(ownerView.status, 200);
      assert.equal(ownerView.body.billableDays, 2);
      assert.equal(ownerView.body.totalAmount, 20000);
    } finally {
      await publish((config) => {
        config.modules.rentals.hideBookingPricingWithoutFinancials = false;
      });
    }
  });

  it('PATCH /rentals/:id rejects unknown billableDays types', async () => {
    const vehicle = await addVehicle({ dailyRate: 1000, depositAmount: 0 });
    const renter = await addRenter();
    const created = (await book(vehicle, renter)).body;
    const bad = await staff('PATCH', `/rentals/${created.id}`, { billableDays: 'two' });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.issues.some((i) => i.path === 'billableDays'), JSON.stringify(bad.body));
  });
});
