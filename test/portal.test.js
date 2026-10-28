const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPublicRouter } = require('../src/routes/public');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createPlatformService } = require('../src/platform/service');
const { todayIn, addDays } = require('../src/tenant/common');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk } = require('./helpers/fakeClerk');
const { createFakeStorage } = require('./helpers/fakeStorage');

// Shenaly-like tenant: Sri Lanka template, guest portal on, documents with scans required.
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const TODAY = todayIn('Asia/Colombo');
const UNLIMITED = { requests: { windowMs: 60_000, max: 10_000 }, uploads: { windowMs: 60_000, max: 10_000 }, bookings: { windowMs: 60_000, max: 10_000 } };

let db;
let service;
let storage;
let portalTenant;
let closedTenant;
let vehicles;
const servers = [];
let baseUrl;

async function listen(limits) {
  const router = createPublicRouter({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, directory: service, storage, cacheTtlMs: 0, limits });
  const server = express().use(express.json()).use('/api/public/:slug', router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api/public`;
}

const request = (url) => async (method, path, body) => {
  const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const guest = (...args) => request(baseUrl)(...args);

const models = () => db.getTenantDb(portalTenant.dbName).models;

async function publish(tenant, change) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  change(config);
  await service.publishConfig(tenant.id, { config, note: 'Test change', baseVersion: active.version }, ADMIN);
}

/** What the booking page does for each document: sign, post the file to Cloudinary, keep the response. */
async function scan(slug = 'beach-rides') {
  const signed = await guest('POST', `/${slug}/uploads`, { kind: 'document' });
  assert.equal(signed.status, 201, JSON.stringify(signed.body));
  return storage.upload(signed.body.fields, { format: 'jpg', bytes: 1_500_000 });
}

const localRenter = async (overrides = {}) => ({
  fullName: 'Amaya Fernando',
  phone: '+94775556667',
  residentType: 'local',
  documents: [
    { type: 'NIC', number: '199512345678', file: await scan() },
    { type: 'DRIVING_LICENSE_LK', number: 'B7788', file: await scan() }
  ],
  ...overrides
});

before(async () => {
  db = await startTestDb();
  storage = createFakeStorage();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk: createFakeClerk(), storage });
  const limits = { maxVehicles: 20, maxUsers: 5, storageGb: 5 };
  ({ tenant: portalTenant } = await service.createTenant({ name: 'Beach Rides', slug: 'beach-rides', template: 'sri-lanka', adminEmail: 'a@beach.example', limits }, ADMIN));
  ({ tenant: closedTenant } = await service.createTenant({ name: 'Closed Rentals', slug: 'closed-rentals', template: 'base', adminEmail: 'b@closed.example', limits }, ADMIN));
  vehicles = await models().Vehicle.create([
    { plateNumber: 'WP CAR-0001', make: 'Suzuki', model: 'Alto', year: 2019, dailyRate: 6000, depositAmount: 15000, status: 'AVAILABLE' },
    { plateNumber: 'WP CAR-0002', make: 'Toyota', model: 'Axio', year: 2021, dailyRate: 11000, depositAmount: 25000, status: 'AVAILABLE' },
    { plateNumber: 'WP CAR-0003', make: 'Honda', model: 'Vezel', year: 2020, dailyRate: 15000, depositAmount: 30000, status: 'MAINTENANCE' }
  ]);
  baseUrl = await listen(UNLIMITED);
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('the booking page', () => {
  it("shows the tenant's branding, document types and form fields", async () => {
    const { status, body } = await guest('GET', '/beach-rides');
    assert.equal(status, 200);
    assert.equal(body.tenant.slug, 'beach-rides');
    assert.equal(body.locale.currency, 'LKR');
    assert.equal(body.today, TODAY);
    assert.equal(body.requireDocumentUpload, true);
    assert.equal(body.uploads, true);
    assert.deepEqual(body.residentTypes, ['local', 'tourist']);
    assert.deepEqual(body.documentTypes.find((d) => d.key === 'PASSPORT').requiredFor, ['tourist']);
    assert.equal(body.fields.renter.email.on, true);
    assert.ok(!('limits' in body) && !('rules' in body));
  });

  it("doesn't exist for an unknown slug, a tenant with the portal off, or a suspended tenant", async () => {
    assert.equal((await guest('GET', '/no-such-tenant')).status, 404);
    assert.equal((await guest('GET', '/closed-rentals')).status, 404);
    await service.setTenantStatus(portalTenant.id, 'suspended', ADMIN);
    try {
      assert.equal((await guest('GET', '/beach-rides')).status, 404);
    } finally {
      await service.setTenantStatus(portalTenant.id, 'active', ADMIN);
    }
    assert.ok(closedTenant.id);
  });
});

describe('vehicles for dates', () => {
  it('lists the free vehicles, cheapest first, without plates', async () => {
    const { status, body } = await guest('GET', `/beach-rides/vehicles?startDate=${addDays(TODAY, 30)}&endDate=${addDays(TODAY, 33)}`);
    assert.equal(status, 200);
    assert.equal(body.totalDays, 3);
    assert.deepEqual(body.vehicles.map((v) => v.model), ['Alto', 'Axio']);
    assert.equal(body.vehicles[0].totalAmount, 18000);
    assert.ok(!('plateNumber' in body.vehicles[0]));
  });

  it('refuses past or reversed dates', async () => {
    assert.equal((await guest('GET', `/beach-rides/vehicles?startDate=${addDays(TODAY, -2)}&endDate=${TODAY}`)).status, 422);
    assert.equal((await guest('GET', `/beach-rides/vehicles?startDate=${addDays(TODAY, 5)}&endDate=${addDays(TODAY, 5)}`)).status, 422);
  });
});

describe('guest uploads', () => {
  it('signs document scans only', async () => {
    const signed = await guest('POST', '/beach-rides/uploads', { kind: 'document' });
    assert.equal(signed.status, 201);
    assert.match(signed.body.publicId, new RegExp(`^tenants/${portalTenant.id}/documents/`));
    assert.equal(signed.body.fields.type, 'authenticated');
    assert.equal((await guest('POST', '/beach-rides/uploads', { kind: 'bill' })).status, 422);
  });
});

describe('guest bookings', () => {
  const dates = { startDate: addDays(TODAY, 10), endDate: addDays(TODAY, 14) };

  it('registers the renter and books the vehicle, as an online reservation', async () => {
    const { status, body } = await guest('POST', '/beach-rides/bookings', { renter: await localRenter(), vehicleId: String(vehicles[0]._id), ...dates, notes: 'Arriving on UL 225' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.match(body.bookingCode, /^BK-\d{4}-\d{4}$/);
    assert.match(body.profileId, /^CL-\d{4}$/);
    assert.deepEqual(body.vehicle, { make: 'Suzuki', model: 'Alto', year: 2019 });
    assert.equal(body.totalDays, 4);
    assert.equal(body.totalAmount, 24000);
    assert.deepEqual(body.documents, [{ type: 'NIC', scanned: true }, { type: 'DRIVING_LICENSE_LK', scanned: true }]);

    const rental = await models().Rental.findOne({ code: body.bookingCode }).lean();
    assert.equal(rental.status, 'RESERVED');
    assert.equal(rental.source, 'ONLINE');
    assert.equal(rental.notes, 'Arriving on UL 225');
    assert.equal(rental.createdBy.name, 'Guest portal');
    const renter = await models().Renter.findById(rental.renter).lean();
    assert.equal(renter.source, 'ONLINE');
    assert.equal(renter.documents.every((d) => d.file?.publicId && !d.verified), true);
    const audit = await models().AuditLog.find({ 'actor.id': 'guest-portal' }).lean();
    assert.deepEqual(audit.map((a) => a.action).sort(), ['rental.reserved', 'renter.created']);
    assert.ok((await db.platformDb.models.Tenant.findById(portalTenant.id).lean()).usage.storageGb > 0);
  });

  it("doesn't say whose booking is in the way", async () => {
    const { status, body } = await guest('POST', '/beach-rides/bookings', { renter: await localRenter(), vehicleId: String(vehicles[0]._id), ...dates });
    assert.equal(status, 409);
    assert.doesNotMatch(body.error.message, /BK-|WP /);
    const maintenance = await guest('POST', '/beach-rides/bookings', { renter: await localRenter(), vehicleId: String(vehicles[2]._id), ...dates });
    assert.equal(maintenance.status, 409);
    assert.doesNotMatch(maintenance.body.error.message, /WP /);
  });

  it('needs the scans of the documents the renter type requires', async () => {
    const withoutScan = await guest('POST', '/beach-rides/bookings', {
      renter: await localRenter({ documents: [{ type: 'NIC', number: '1', file: await scan() }, { type: 'DRIVING_LICENSE_LK', number: '2' }] }),
      vehicleId: String(vehicles[1]._id),
      ...dates
    });
    assert.equal(withoutScan.status, 422);
    assert.deepEqual(withoutScan.body.error.issues.map((i) => i.path), ['renter.documents[1].file']);

    const tourist = await guest('POST', '/beach-rides/bookings', { renter: await localRenter({ residentType: 'tourist', documents: [] }), vehicleId: String(vehicles[1]._id), ...dates });
    assert.equal(tourist.status, 422);
    assert.match(tourist.body.error.issues[0].message, /Passport/);
  });

  it("refuses another tenant's or a forged file", async () => {
    const renter = await localRenter();
    renter.documents[0].file = { ...renter.documents[0].file, signature: 'f'.repeat(40) };
    const forged = await guest('POST', '/beach-rides/bookings', { renter, vehicleId: String(vehicles[1]._id), ...dates });
    assert.equal(forged.status, 422);
    assert.deepEqual(forged.body.error.issues.map((i) => i.path), ['renter.documents[0].file']);
  });

  it("follows the config's resident types and required fields", async () => {
    await publish(portalTenant, (config) => {
      config.modules.guestPortal.residentTypes = ['local'];
      config.fields.renters.builtIn.email.required = true;
    });
    try {
      const tourist = await guest('POST', '/beach-rides/bookings', { renter: await localRenter({ residentType: 'tourist' }), vehicleId: String(vehicles[1]._id), ...dates });
      assert.equal(tourist.status, 422);
      assert.deepEqual(tourist.body.error.issues.map((i) => i.path).sort(), ['renter.email', 'renter.residentType']);
    } finally {
      await publish(portalTenant, (config) => {
        config.modules.guestPortal.residentTypes = ['local', 'tourist'];
        config.fields.renters.builtIn.email.required = false;
      });
    }
  });

  it('books without scans when the portal makes them optional', async () => {
    await publish(portalTenant, (config) => {
      config.modules.guestPortal.requireDocumentUpload = false;
    });
    try {
      const { status, body } = await guest('POST', '/beach-rides/bookings', {
        renter: { fullName: 'Ravi Kumar', phone: '+94771234000', residentType: 'local', documents: [{ type: 'NIC', number: '200011112222' }] },
        vehicleId: String(vehicles[1]._id),
        ...dates
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.deepEqual(body.documents, [{ type: 'NIC', scanned: false }]);
    } finally {
      await publish(portalTenant, (config) => {
        config.modules.guestPortal.requireDocumentUpload = true;
      });
    }
  });
});

describe('rate limits', () => {
  it('answers 429 with Retry-After past the limit', async () => {
    const strict = request(await listen({ ...UNLIMITED, bookings: { windowMs: 60_000, max: 1 } }));
    assert.equal((await strict('POST', '/beach-rides/bookings', {})).status, 422);
    const limited = await strict('POST', '/beach-rides/bookings', {});
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await strict('GET', '/beach-rides')).status, 200);
  });
});
