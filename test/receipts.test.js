const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTenantRouter } = require('../src/routes/tenant');
const { createPlatformRouter } = require('../src/routes/platform');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createPlatformService } = require('../src/platform/service');
const { CONFIG_TEMPLATES } = require('../src/platform/config/templates');
const { parseTenantConfig } = require('../src/platform/config/schema');
const { renderReturnReceipt, pdfText, settlementOf } = require('../src/platform/documents/returnReceipt');
const { sampleReceipt } = require('../src/platform/documents/sample');
const { embeddableUrl } = require('../src/platform/documents/images');
const { unauthenticated } = require('../src/platform/errors');
const { todayIn, addDays } = require('../src/tenant/common');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');
const { createFakeStorage } = require('./helpers/fakeStorage');

const ORG = orgIdFor('receipts');
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const TODAY = todayIn('Asia/Colombo');
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The text of an uncompressed PDF that pdfkit wrote: each `[<hex> …] TJ` run, one per line. */
function textOf(pdf) {
  const source = pdf.toString('latin1');
  return [...source.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .map(([, run]) => [...run.matchAll(/<([0-9a-fA-F]*)>/g)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''))
    .join('\n');
}
/** Images in a PDF, not counting the transparency masks pdfkit adds to PNGs with alpha. */
const imageCount = (pdf) => {
  const source = pdf.toString('latin1');
  return (source.match(/\/Subtype \/Image/g) ?? []).length - (source.match(/\/SMask /g) ?? []).length;
};

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: ORG };
  next();
}

let db;
let service;
let storage;
let tenant;
let baseUrl;
let platformUrl;
const servers = [];
const logoRequests = [];

async function listen(mount, router) {
  const server = express().use(express.json()).use(mount, router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}${mount}`;
}

/** Calls the API; a PDF comes back as `pdf` (a Buffer) with its headers. */
const call = (url, user) => async (method, path, body) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-role': 'super_admin' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.headers.get('content-type') === 'application/pdf') {
    return { status: res.status, headers: res.headers, pdf: Buffer.from(await res.arrayBuffer()) };
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const owner = (...args) => call(baseUrl, 'user_owner')(...args);
const staff = (...args) => call(baseUrl, 'user_staff')(...args);
const accountant = (...args) => call(baseUrl, 'user_accountant')(...args);

async function publish(change) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  change(config);
  await service.publishConfig(tenant.id, { config, note: 'Test change', baseVersion: active.version }, ADMIN);
}

async function uploadPhoto() {
  const signed = await staff('POST', '/uploads', { kind: 'inspection' });
  assert.equal(signed.status, 201, JSON.stringify(signed.body));
  return storage.upload(signed.body.fields);
}

let plates = 100;
/** A rental booked, handed over (a photo per point) and, unless `returned` is false, returned. */
async function rentalThrough({ returned = true } = {}) {
  const { inspectionPoints } = (await service.getActiveConfig(tenant.id)).config.modules.rentals;
  const photos = async () => Promise.all(inspectionPoints.map(async (point) => ({ point, file: await uploadPhoto() })));
  const vehicle = await owner('POST', '/vehicles', { plateNumber: `WP RCP-${plates++}`, make: 'Toyota', model: 'Aqua', year: 2021, dailyRate: 10000, depositAmount: 20000, mileage: 1000 });
  assert.equal(vehicle.status, 201, JSON.stringify(vehicle.body));
  const renter = await staff('POST', '/renters', {
    fullName: 'José Ñuñez',
    phone: '+94771234567',
    email: 'jose@example.com',
    documents: [{ type: 'NIC', number: '1', verified: true }, { type: 'DRIVING_LICENSE_LK', number: '2', verified: true }]
  });
  assert.equal(renter.status, 201, JSON.stringify(renter.body));
  const booked = await staff('POST', '/rentals', {
    vehicleId: vehicle.body.id,
    renterId: renter.body.id,
    startDate: TODAY,
    endDate: addDays(TODAY, 3),
    notes: 'Airport drop-off',
    advance: { amount: 30000, method: 'CASH', transactionReference: 'SLIP-77' },
    pickup: { photos: await photos(), odometer: 1000 }
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  if (!returned) return booked.body;
  const done = await staff('POST', `/rentals/${booked.body.id}/return`, { odometer: 1420, photos: await photos(), notes: 'Fuel full' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}

before(async () => {
  db = await startTestDb();
  storage = createFakeStorage();
  const clerk = createFakeClerk();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk, storage });
  ({ tenant } = await service.createTenant(
    { name: 'Receipts Co', slug: 'receipts', template: 'sri-lanka', adminEmail: 'a@receipts.example', limits: { maxVehicles: 20, maxUsers: 20, storageGb: 1 } },
    ADMIN
  ));
  const { Member } = db.getTenantDb(tenant.dbName).models;
  for (const [clerkUserId, roleKey] of [['user_owner', 'owner'], ['user_staff', 'staff'], ['user_accountant', 'accountant']]) {
    await Member.create({ clerkUserId, email: `${clerkUserId}@receipts.example`, name: clerkUserId.replace('user_', ''), roleKey });
  }
  const loadLogo = async (url) => {
    logoRequests.push(url);
    return url ? PIXEL_PNG : null;
  };
  baseUrl = await listen(
    '/api/v1',
    createTenantRouter({ tenantAuth: stubTenantAuth, platformDb: db.platformDb, getTenantDb: db.getTenantDb, directory: service, clerk, storage, loadLogo, cacheTtlMs: 0 })
  );
  const stubPlatformAuth = (req, res, next) => {
    req.actor = { id: 'user_super', name: 'Super Admin' };
    next();
  };
  platformUrl = await listen('/api/platform', createPlatformRouter({ service, platformAuth: stubPlatformAuth, platformDb: db.platformDb, loadLogo }));
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('the return receipt PDF', () => {
  const config = () => structuredClone(CONFIG_TEMPLATES['sri-lanka'].config);
  const render = (cfg, receipt = sampleReceipt(cfg, { issuedBy: 'Nimal' })) => renderReturnReceipt({ config: cfg, receipt }, { compress: false });

  it('confirms the return, with the charges, payments, details and both inspections', async () => {
    const cfg = config();
    cfg.branding.displayName = 'Shenaly Rent a Car';
    cfg.documents.returnReceipt.issuerDetails = ['No. 12, Galle Road, Colombo 03'];
    const pdf = await render(cfg);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const text = textOf(pdf);
    for (const expected of [
      'Shenaly Rent a Car',
      'No. 12, Galle Road, Colombo 03',
      'Rental invoice & return receipt',
      'VEHICLE RETURNED',
      'This confirms that Sample Renter returned the Toyota Aqua (CAB-4321)',
      'Paid in full',
      'Payments',
      'Booking advance',
      'Pickup inspection',
      'Return inspection',
      'Signature and date',
      'Thank you for renting with Shenaly Rent a Car.',
      'Issued'
    ]) {
      assert.ok(text.includes(expected), `Missing "${expected}"`);
    }
  });

  it('leaves out the parts the config turns off, and uses its texts', async () => {
    const cfg = config();
    Object.assign(cfg.documents.returnReceipt, {
      title: 'Return note',
      returnStatement: '{plateNumber} is back at {businessName}.',
      footer: '',
      showPayments: false,
      showInspections: false,
      showCustomFields: false,
      showSignatures: false
    });
    const text = textOf(await render(cfg));
    assert.ok(text.includes('Return note'));
    assert.ok(text.includes('CAB-4321 is back at New Rental Company.'));
    for (const missing of ['Booking advance', 'Pickup inspection', 'Signature and date', 'Rental details', 'Thank you']) {
      assert.ok(!text.includes(missing), `Unexpected "${missing}"`);
    }
  });

  it('embeds photos and the logo it can, and draws placeholders for the rest', async () => {
    const cfg = config();
    const receipt = sampleReceipt(cfg);
    receipt.inspections[0].record.photos[0].image = PIXEL_PNG;
    receipt.inspections[1].record.photos[0].image = Buffer.from('not an image');
    const pdf = await renderReturnReceipt({ config: cfg, receipt, logo: PIXEL_PNG }, { compress: false });
    assert.equal(imageCount(pdf), 2);
    cfg.documents.returnReceipt.showInspectionPhotos = false;
    assert.equal(imageCount(await renderReturnReceipt({ config: cfg, receipt }, { compress: false })), 0);
  });

  it('counts a refunded deposit as settled, and shows what is still owed', () => {
    const base = { totalAmount: 30000, depositAmount: 20000 };
    assert.deepEqual(settlementOf({ ...base, paidAmount: 30000, depositRefunded: true }), { total: 30000, paid: 30000, balance: 0 });
    assert.deepEqual(settlementOf({ ...base, paidAmount: 30000, depositRefunded: false }), { total: 50000, paid: 30000, balance: 20000 });
  });

  it('writes text the PDF fonts can draw', () => {
    assert.equal(pdfText('José Ñuñez · €5 – ok'), 'José Ñuñez · €5 – ok');
    assert.equal(pdfText('Łukasz Dvořák'), '?ukasz Dvorák');
    assert.equal(pdfText('Иван 1 000'), '???? 1 000');
  });

  it('asks Cloudinary for a logo as a PNG', () => {
    assert.equal(embeddableUrl('https://res.cloudinary.com/demo/image/upload/v1/tenants/t/branding/x.webp'), 'https://res.cloudinary.com/demo/image/upload/v1/tenants/t/branding/x.png');
    assert.equal(embeddableUrl('https://example.com/logo.webp'), 'https://example.com/logo.webp');
  });
});

describe('downloading a return receipt', () => {
  let rental;

  before(async () => {
    rental = await rentalThrough();
  });

  it('downloads a completed rental as a PDF, with its inspection photos', async () => {
    const res = await staff('GET', `/rentals/${rental.id}/return-receipt`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${rental.code}-return-receipt.pdf"`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.pdf.subarray(0, 5).toString(), '%PDF-');
    const points = (await service.getActiveConfig(tenant.id)).config.modules.rentals.inspectionPoints;
    // Every pickup and return photo, read back from storage.
    assert.equal(imageCount(res.pdf), points.length * 2);
    assert.equal((await accountant('GET', `/rentals/${rental.id}/return-receipt`)).status, 200);
  });

  it("isn't there before the return, when it's turned off, or for another rental", async () => {
    const active = await rentalThrough({ returned: false });
    const early = await staff('GET', `/rentals/${active.id}/return-receipt`);
    assert.equal(early.status, 409);
    assert.match(early.body.error.message, /hasn't been returned yet/);
    assert.equal((await staff('GET', `/rentals/${'0'.repeat(24)}/return-receipt`)).status, 404);

    await publish((config) => (config.documents.returnReceipt.enabled = false));
    try {
      const off = await staff('GET', `/rentals/${rental.id}/return-receipt`);
      assert.equal(off.status, 404);
      assert.match(off.body.error.message, /turned off/);
    } finally {
      await publish((config) => (config.documents.returnReceipt.enabled = true));
    }
  });

  it('fetches the logo, and still issues the receipt when a photo is gone', async () => {
    await publish((config) => (config.branding.logoUrl = 'https://res.cloudinary.com/demo/image/upload/v1/logo.png'));
    const [, firstPhoto] = [...storage.assets.keys()].filter((id) => id.includes('/inspections/'));
    storage.assets.delete(firstPhoto);
    try {
      const res = await staff('GET', `/rentals/${rental.id}/return-receipt`);
      assert.equal(res.status, 200);
      assert.ok(logoRequests.includes('https://res.cloudinary.com/demo/image/upload/v1/logo.png'));
    } finally {
      await publish((config) => (config.branding.logoUrl = null));
    }
  });
});

describe('previewing the return receipt', () => {
  const preview = (body) => call(platformUrl, 'user_super')('POST', '/documents/return-receipt/preview', body);

  it("renders a sample rental with a draft config, for the config editor", async () => {
    const config = structuredClone(CONFIG_TEMPLATES.base.config);
    config.documents.returnReceipt.title = 'Draft receipt';
    const res = await preview({ config });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(res.headers.get('content-disposition'), /preview-RNT-\d{4}-0042-return-receipt\.pdf/);
  });

  it('refuses a config that does not validate', async () => {
    const config = structuredClone(CONFIG_TEMPLATES.base.config);
    config.documents.returnReceipt.returnStatement = 'Returned by {guest}';
    const res = await preview({ config });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.issues.map((i) => i.path), ['documents.returnReceipt.returnStatement']);
    assert.equal((await preview({ configText: '{ nope' })).status, 422);
  });
});

describe('documents config', () => {
  it('fills in the return receipt for configs from before it existed', () => {
    const config = structuredClone(CONFIG_TEMPLATES['sri-lanka'].config);
    delete config.documents;
    const { success, data } = parseTenantConfig(config);
    assert.equal(success, true);
    assert.equal(data.documents.returnReceipt.enabled, true);
    assert.equal(data.documents.returnReceipt.paperSize, 'A4');
    assert.equal(CONFIG_TEMPLATES.base.config.documents.returnReceipt.paperSize, 'LETTER');
  });
});
