const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createTenantRouter } = require('../src/routes/tenant');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createPlatformService } = require('../src/platform/service');
const { createStorageGateway, parseCloudinaryUrl } = require('../src/platform/storage');
const { unauthenticated } = require('../src/platform/errors');
const { todayIn, addDays } = require('../src/tenant/common');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');
const { createFakeStorage } = require('./helpers/fakeStorage');

// Tenant A: Sri Lanka template (every module on, pickup and drop inspections required). Tenant B: base template.
const ORG_A = orgIdFor('files-a');
const ORG_B = orgIdFor('files-b');
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const TODAY = todayIn('Asia/Colombo');
const MB = 1024 ** 2;

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: req.get('x-test-org') ?? ORG_A };
  next();
}

let db;
let service;
let storage;
let tenantA;
let tenantB;
let points;
const servers = [];
let baseUrl;
let unconfiguredUrl;

const call = (url, user, org = ORG_A) => async (method, path, body) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-org': org },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const owner = (...args) => call(baseUrl, 'user_owner')(...args);
const staff = (...args) => call(baseUrl, 'user_staff')(...args);
const accountant = (...args) => call(baseUrl, 'user_accountant')(...args);
const ownerB = (...args) => call(baseUrl, 'user_b_owner', ORG_B)(...args);

const tenantDoc = (tenant) => db.platformDb.models.Tenant.findById(tenant.id).lean();

/** What the app does: ask for a signed upload, post the file to Cloudinary, keep the response. */
async function uploadAs(caller, kind, options) {
  const signed = await caller('POST', '/uploads', { kind });
  assert.equal(signed.status, 201, JSON.stringify(signed.body));
  return storage.upload(signed.body.fields, options);
}

async function publish(tenant, change) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  change(config);
  await service.publishConfig(tenant.id, { config, note: 'Test change', baseVersion: active.version }, ADMIN);
}

async function listen(router) {
  const server = express().use(express.json()).use('/api/v1', router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}

let plates = 100;
async function addVehicle() {
  const res = await owner('POST', '/vehicles', { plateNumber: `WP FIL-${plates++}`, make: 'Toyota', model: 'Aqua', year: 2020, dailyRate: 9000, mileage: 1000 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  db = await startTestDb();
  storage = createFakeStorage();
  const clerk = createFakeClerk();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk, storage });
  const limits = { maxVehicles: 20, maxUsers: 20, storageGb: 1 };
  ({ tenant: tenantA } = await service.createTenant({ name: 'Files A', slug: 'files-a', template: 'sri-lanka', adminEmail: 'a@files.example', limits }, ADMIN));
  ({ tenant: tenantB } = await service.createTenant({ name: 'Files B', slug: 'files-b', template: 'base', adminEmail: 'b@files.example', limits }, ADMIN));
  points = (await service.getActiveConfig(tenantA.id)).config.modules.rentals.inspectionPoints;

  const { Member } = db.getTenantDb(tenantA.dbName).models;
  for (const [clerkUserId, roleKey] of [['user_owner', 'owner'], ['user_staff', 'staff'], ['user_accountant', 'accountant']]) {
    await Member.create({ clerkUserId, email: `${clerkUserId}@files.example`, name: clerkUserId.replace('user_', ''), roleKey });
  }
  await db.getTenantDb(tenantB.dbName).models.Member.create({ clerkUserId: 'user_b_owner', email: 'b@files.example', roleKey: 'owner' });

  const routerWith = (gateway) =>
    createTenantRouter({ tenantAuth: stubTenantAuth, platformDb: db.platformDb, getTenantDb: db.getTenantDb, directory: service, clerk, storage: gateway, cacheTtlMs: 0 });
  baseUrl = await listen(routerWith(storage));
  unconfiguredUrl = await listen(routerWith(createStorageGateway({})));
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('the Cloudinary gateway', () => {
  const gateway = createStorageGateway({ url: 'cloudinary://123456:s3cr3t@demo-cloud' });

  it('reads CLOUDINARY_URL and refuses anything else', () => {
    assert.deepEqual(parseCloudinaryUrl('cloudinary://123456:s3cr3t@demo-cloud'), { apiKey: '123456', apiSecret: 's3cr3t', cloudName: 'demo-cloud' });
    assert.throws(() => parseCloudinaryUrl('https://demo-cloud'), /CLOUDINARY_URL/);
  });

  it('signs every upload field with the API secret, as Cloudinary documents it', () => {
    const { uploadUrl, fields } = gateway.signUpload({ publicId: 'tenants/t1/bills/x', type: 'authenticated', allowedFormats: ['jpg', 'pdf'] });
    assert.equal(uploadUrl, 'https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    const { api_key: apiKey, signature, ...signed } = fields;
    assert.equal(apiKey, '123456');
    const expected = Object.keys(signed).sort().map((key) => `${key}=${signed[key]}`).join('&');
    assert.equal(signature, crypto.createHash('sha1').update(`${expected}s3cr3t`).digest('hex'));
    assert.equal(signed.allowed_formats, 'jpg,pdf');
  });

  it('accepts only the response signature Cloudinary would compute', () => {
    const response = { publicId: 'tenants/t1/bills/x', version: 1760000000 };
    const signature = crypto.createHash('sha1').update(`public_id=${response.publicId}&version=${response.version}s3cr3t`).digest('hex');
    assert.equal(gateway.verifyUpload({ ...response, signature }), true);
    assert.equal(gateway.verifyUpload({ ...response, signature: signature.replace(/.$/, '0') }), false);
  });

  it('makes download links that expire after 10 minutes', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    const link = new URL(gateway.downloadUrl({ publicId: 'tenants/t1/documents/x', format: 'pdf', now }));
    assert.equal(`${link.origin}${link.pathname}`, 'https://api.cloudinary.com/v1_1/demo-cloud/image/download');
    assert.equal(link.searchParams.get('type'), 'authenticated');
    assert.equal(Number(link.searchParams.get('expires_at')), Math.floor(now.getTime() / 1000) + 600);
  });

  it('links public images on the CDN', () => {
    assert.equal(gateway.publicUrl({ publicId: 'tenants/t1/vehicles/x', format: 'jpg' }), 'https://res.cloudinary.com/demo-cloud/image/upload/v1/tenants/t1/vehicles/x.jpg');
  });

  it('responds 503 storage_not_configured without CLOUDINARY_URL', () => {
    const missing = createStorageGateway({});
    assert.equal(missing.configured, false);
    assert.throws(() => missing.signUpload({}), (error) => error.status === 503 && error.code === 'storage_not_configured');
  });
});

describe('signed uploads', () => {
  it('signs a private upload under the tenant folder of the kind', async () => {
    const { status, body } = await staff('POST', '/uploads', { kind: 'document' });
    assert.equal(status, 201);
    assert.match(body.publicId, new RegExp(`^tenants/${tenantA.id}/documents/[0-9a-f-]{36}$`));
    assert.equal(body.fields.public_id, body.publicId);
    assert.equal(body.fields.type, 'authenticated');
    assert.equal(body.fields.allowed_formats, 'jpg,jpeg,png,webp,pdf');

    const photo = await staff('POST', '/uploads', { kind: 'inspection' });
    assert.match(photo.body.publicId, /\/inspections\//);
    assert.equal(photo.body.fields.format, 'jpg');
    assert.equal(photo.body.fields.transformation, 'c_limit,h_2000,w_2000');
  });

  it('signs a public upload for a vehicle photo', async () => {
    const { status, body } = await staff('POST', '/uploads', { kind: 'vehiclePhoto' });
    assert.equal(status, 201);
    assert.match(body.publicId, new RegExp(`^tenants/${tenantA.id}/vehicles/[0-9a-f-]{36}$`));
    assert.equal(body.fields.type, 'upload');
    assert.equal(body.fields.format, 'jpg');
    assert.equal(body.fields.transformation, 'c_limit,h_1600,w_1600');
    assert.equal((await accountant('POST', '/uploads', { kind: 'vehiclePhoto' })).status, 403);
  });

  it('needs a permission that writes records of the kind', async () => {
    assert.equal((await accountant('POST', '/uploads', { kind: 'bill' })).status, 201);
    const document = await accountant('POST', '/uploads', { kind: 'document' });
    assert.equal(document.status, 403);
    assert.match(document.body.error.message, /renters:create or renters:update/);
    assert.equal((await staff('POST', '/uploads', { kind: 'logo' })).status, 422);
  });

  it('is off with the module', async () => {
    await publish(tenantB, (config) => {
      config.modules.costs.enabled = false;
      config.navigation = config.navigation.filter((item) => item.module !== 'costs');
    });
    assert.equal((await ownerB('POST', '/uploads', { kind: 'bill' })).status, 404);
    assert.equal((await ownerB('POST', '/uploads', { kind: 'document' })).status, 201);
  });

  it('responds 503 without storage, and records with files are refused', async () => {
    const unconfigured = call(unconfiguredUrl, 'user_staff');
    const signed = await unconfigured('POST', '/uploads', { kind: 'document' });
    assert.equal(signed.status, 503);
    assert.equal(signed.body.error.code, 'storage_not_configured');
    const file = await uploadAs(staff, 'document');
    const created = await unconfigured('POST', '/renters', { fullName: 'No Storage', phone: '+94770000001', documents: [{ type: 'NIC', number: '1', file }] });
    assert.equal(created.status, 503);
    assert.equal((await unconfigured('POST', '/renters', { fullName: 'No File', phone: '+94770000002' })).status, 201);
  });

  it('refuses an upload once storage is full', async () => {
    const { Tenant } = db.platformDb.models;
    await Tenant.updateOne({ _id: tenantA.id }, { $set: { 'usage.storageGb': 1 } });
    try {
      const full = await staff('POST', '/uploads', { kind: 'inspection' });
      assert.equal(full.status, 409);
      assert.match(full.body.error.message, /1 GB of file storage is full/);
    } finally {
      await Tenant.updateOne({ _id: tenantA.id }, { $set: { 'usage.storageGb': 0 } });
    }
  });
});

describe('renter document scans', () => {
  let renter;

  it('registers a renter with a scan, served through an expiring link', async () => {
    const file = await uploadAs(staff, 'document', { format: 'pdf', bytes: 3 * MB });
    const { status, body } = await staff('POST', '/renters', {
      fullName: 'Kasun Silva',
      phone: '+94771112223',
      documents: [{ type: 'NIC', number: '199012345678', file }]
    });
    assert.equal(status, 201, JSON.stringify(body));
    renter = body;
    const [document] = body.documents;
    assert.equal(document.file.format, 'pdf');
    assert.equal(document.file.bytes, 3 * MB);
    assert.match(document.file.url, /expires_at=/);
    assert.ok(document.file.url.includes(encodeURIComponent(file.publicId)));

    const stored = (await db.getTenantDb(tenantA.dbName).models.Renter.findById(body.id).lean()).documents[0].file;
    assert.equal(stored.publicId, file.publicId);
    assert.ok((await tenantDoc(tenantA)).usage.storageGb > 0);
  });

  it('refuses a forged, foreign or wrong-kind upload', async () => {
    const file = await uploadAs(staff, 'document');
    const forged = await staff('POST', `/renters/${renter.id}/documents`, { type: 'PASSPORT', number: 'N1', file: { ...file, signature: '0'.repeat(40) } });
    assert.equal(forged.status, 422);
    assert.deepEqual(forged.body.error.issues.map((i) => i.path), ['file']);

    const foreign = await uploadAs(ownerB, 'document');
    const crossTenant = await staff('POST', `/renters/${renter.id}/documents`, { type: 'PASSPORT', number: 'N1', file: foreign });
    assert.equal(crossTenant.status, 422);
    assert.deepEqual(crossTenant.body.error.issues.map((i) => i.path), ['file.publicId']);

    const bill = await uploadAs(staff, 'bill');
    assert.equal((await staff('POST', `/renters/${renter.id}/documents`, { type: 'PASSPORT', number: 'N1', file: bill })).status, 422);
  });

  it('adds a document without a scan, then attaches one and replaces it', async () => {
    const added = await staff('POST', `/renters/${renter.id}/documents`, { type: 'DRIVING_LICENSE_LK', number: 'B123' });
    assert.equal(added.status, 201);
    const document = added.body.documents.find((d) => d.type === 'DRIVING_LICENSE_LK');
    assert.equal(document.file, null);

    const first = await uploadAs(staff, 'document');
    const attached = await staff('PUT', `/renters/${renter.id}/documents/${document.id}/file`, { file: first });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.ok(attached.body.documents.find((d) => d.id === document.id).file.url);

    const second = await uploadAs(staff, 'document');
    await staff('PUT', `/renters/${renter.id}/documents/${document.id}/file`, { file: second });
    assert.ok(storage.deleted.includes(first.publicId));
    assert.ok(!storage.deleted.includes(second.publicId));
    assert.equal((await staff('PUT', `/renters/${renter.id}/documents/${'0'.repeat(24)}/file`, { file: second })).status, 404);
  });

  it("never shows another tenant's renters", async () => {
    assert.equal((await ownerB('GET', `/renters/${renter.id}`)).status, 404);
  });
});

describe('inspection photos', () => {
  let renter;

  before(async () => {
    const res = await staff('POST', '/renters', { fullName: 'Photo Renter', phone: '+94772223334', documents: [{ type: 'NIC', number: '1', verified: true }, { type: 'DRIVING_LICENSE_LK', number: '2', verified: true }] });
    renter = res.body;
  });

  const book = async () => {
    const vehicle = await addVehicle();
    const res = await staff('POST', '/rentals', { vehicleId: vehicle.id, renterId: renter.id, startDate: TODAY, endDate: addDays(TODAY, 2) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const photosFor = (list) => Promise.all(list.map(async (point) => ({ point, file: await uploadAs(staff, 'inspection') })));

  it('takes a photo per point at check-in and return; a photo checks its point', async () => {
    const rental = await book();
    const before = (await tenantDoc(tenantA)).usage.storageGb;
    const pickup = await staff('POST', `/rentals/${rental.id}/check-in`, { photos: await photosFor(points) });
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    assert.deepEqual(pickup.body.pickupInspection.points, points);
    assert.equal(pickup.body.pickupInspection.photos.length, points.length);
    assert.match(pickup.body.pickupInspection.photos[0].file.url, /expires_at=/);
    assert.ok((await tenantDoc(tenantA)).usage.storageGb > before);

    const drop = await staff('POST', `/rentals/${rental.id}/return`, { odometer: 1200, checkedPoints: points, photos: await photosFor(points.slice(0, 2)) });
    assert.equal(drop.status, 200, JSON.stringify(drop.body));
    assert.deepEqual(drop.body.dropInspection.points, points);
    assert.deepEqual(drop.body.dropInspection.photos.map((p) => p.point), points.slice(0, 2));
  });

  it('refuses photos of unknown points, two photos of a point, and missing points', async () => {
    const rental = await book();
    const [photo] = await photosFor([points[0]]);
    const unknown = await staff('POST', `/rentals/${rental.id}/check-in`, { checkedPoints: points, photos: [{ ...photo, point: 'Roof' }] });
    assert.equal(unknown.status, 422);
    const twice = await staff('POST', `/rentals/${rental.id}/check-in`, { checkedPoints: points, photos: [photo, photo] });
    assert.equal(twice.status, 422);
    assert.deepEqual(twice.body.error.issues.map((i) => i.path), ['photos[1].point']);
    const missing = await staff('POST', `/rentals/${rental.id}/check-in`, { photos: [photo] });
    assert.equal(missing.status, 422);
    assert.match(missing.body.error.message, /Check every inspection point/);
  });

  it('takes photos when booking and handing over in one step', async () => {
    const vehicle = await addVehicle();
    const res = await staff('POST', '/rentals', {
      vehicleId: vehicle.id,
      renterId: renter.id,
      startDate: TODAY,
      endDate: addDays(TODAY, 1),
      pickup: { checkedPoints: points, photos: await photosFor([points[1]]) }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ACTIVE');
    assert.deepEqual(res.body.pickupInspection.photos.map((p) => p.point), [points[1]]);
  });
});

describe('bills', () => {
  let vehicle;

  before(async () => {
    vehicle = await addVehicle();
  });

  it('logs a cost with its bill, and deleting the cost deletes the bill', async () => {
    const billFile = await uploadAs(staff, 'bill', { format: 'pdf', bytes: 20 * MB });
    const before = (await tenantDoc(tenantA)).usage.storageGb;
    const created = await staff('POST', '/costs', { vehicleId: vehicle.id, category: 'ROUTINE_MAINTENANCE', title: 'Oil change', amount: 12000, billFile });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.bill.format, 'pdf');
    assert.ok(created.body.bill.url);
    const afterUpload = (await tenantDoc(tenantA)).usage.storageGb;
    assert.ok(afterUpload - before > 0.018);

    const listed = (await accountant('GET', '/costs')).body.find((c) => c.id === created.body.id);
    assert.ok(listed.bill.url);

    assert.equal((await owner('DELETE', `/costs/${created.body.id}`)).status, 200);
    assert.ok(storage.deleted.includes(billFile.publicId));
    assert.ok((await tenantDoc(tenantA)).usage.storageGb < afterUpload);
  });

  it('requires the bill with modules.costs.requireBillUpload, and attaches one later', async () => {
    const plain = await staff('POST', '/costs', { vehicleId: vehicle.id, category: 'TIRE_REPLACEMENT', title: 'Two tyres', amount: 40000 });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.bill, null);

    await publish(tenantA, (config) => {
      config.modules.costs.requireBillUpload = true;
    });
    try {
      const refused = await staff('POST', '/costs', { vehicleId: vehicle.id, category: 'TIRE_REPLACEMENT', title: 'Two more', amount: 40000 });
      assert.equal(refused.status, 422);
      assert.deepEqual(refused.body.error.issues.map((i) => i.path), ['billFile']);
    } finally {
      await publish(tenantA, (config) => {
        config.modules.costs.requireBillUpload = false;
      });
    }

    const attached = await staff('PUT', `/costs/${plain.body.id}/bill`, { billFile: await uploadAs(staff, 'bill') });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.ok(attached.body.bill.url);
    assert.equal(attached.body.vehicle.plateNumber, vehicle.plateNumber);
  });
});

describe('vehicle photos', () => {
  it('adds a vehicle with a photo, served from the CDN to guests too', async () => {
    const thumbnail = await uploadAs(owner, 'vehiclePhoto', { bytes: 10 * MB });
    const before = (await tenantDoc(tenantA)).usage.storageGb;
    const created = await owner('POST', '/vehicles', { plateNumber: 'WP PHO-1', make: 'Toyota', model: 'Aqua', year: 2020, dailyRate: 9000, thumbnail });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.thumbnail, `https://res.cloudinary.test/fake/image/upload/${thumbnail.publicId}.jpg`);
    assert.equal(created.body.photo, undefined);
    assert.ok((await tenantDoc(tenantA)).usage.storageGb - before > 0.009);
    assert.equal((await staff('GET', '/vehicles')).body.find((v) => v.id === created.body.id).thumbnail, created.body.thumbnail);
  });

  it('replaces and removes a photo, and deleting the vehicle deletes it', async () => {
    const vehicle = await addVehicle();
    const first = await uploadAs(staff, 'vehiclePhoto');
    assert.equal((await staff('PATCH', `/vehicles/${vehicle.id}`, { thumbnail: first })).status, 200);

    const second = await uploadAs(staff, 'vehiclePhoto');
    const replaced = await staff('PATCH', `/vehicles/${vehicle.id}`, { thumbnail: second });
    assert.match(replaced.body.thumbnail, new RegExp(`${second.publicId}\\.jpg$`));
    assert.ok(storage.deleted.includes(first.publicId));

    const removed = await staff('PATCH', `/vehicles/${vehicle.id}`, { thumbnail: null });
    assert.equal(removed.body.thumbnail, null);
    assert.ok(storage.deleted.includes(second.publicId));

    const third = await uploadAs(staff, 'vehiclePhoto');
    assert.equal((await staff('PATCH', `/vehicles/${vehicle.id}`, { thumbnail: third, mileage: 1200 })).status, 200);
    assert.equal((await owner('DELETE', `/vehicles/${vehicle.id}`)).status, 200);
    assert.ok(storage.deleted.includes(third.publicId));
  });

  it('refuses a typed-in URL or an upload of another kind', async () => {
    const vehicle = await addVehicle();
    const refused = async (thumbnail) => {
      const res = await staff('PATCH', `/vehicles/${vehicle.id}`, { thumbnail });
      assert.equal(res.status, 422);
      return res.body.error.issues.map((i) => i.path);
    };
    assert.deepEqual(await refused('https://example.com/car.jpg'), ['thumbnail']);
    assert.deepEqual(await refused(await uploadAs(staff, 'inspection')), ['thumbnail.publicId']);
  });
});

describe('platform files', () => {
  it('signs a public logo upload for a tenant', async () => {
    const signed = await service.signLogoUpload(tenantA.id);
    assert.match(signed.publicId, new RegExp(`^tenants/${tenantA.id}/branding/`));
    assert.equal(signed.fields.type, 'upload');
  });

  it("deleting a tenant deletes its files", async () => {
    const file = await uploadAs(ownerB, 'document');
    assert.ok(storage.assets.has(file.publicId));
    await service.setTenantStatus(tenantB.id, 'archived', ADMIN);
    await service.deleteTenant(tenantB.id, { confirmSlug: 'files-b' }, ADMIN);
    assert.deepEqual(storage.deletedPrefixes, [`tenants/${tenantB.id}/`]);
    assert.ok(!storage.assets.has(file.publicId));
  });
});
