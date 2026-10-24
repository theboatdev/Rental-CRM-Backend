const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { initTenantDb } = require('../src/db/tenantDb');
const { createTenantRouter } = require('../src/routes/tenant');
const { handle } = require('../src/routes/handle');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createTenantAuth } = require('../src/middleware/tenantAuth');
const { requireModule, requirePermission, resolveTenant } = require('../src/middleware/tenantContext');
const { createPlatformService } = require('../src/platform/service');
const { forbidden, notFound, unauthenticated } = require('../src/platform/errors');
const { PLATFORM_MODEL_NAMES, registerPlatformModels } = require('../src/models/platform');
const { TENANT_MODEL_NAMES } = require('../src/models/tenant');
const { SYSTEM_ROLES } = require('../src/platform/rbac/permissions');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');
const { seedDemoTenants, DEMO_TENANT_IDS } = require('./helpers/demoTenants');

// Org A is the seeded Shenaly tenant (Sri Lanka template, every module on).
// Org B is provisioned below from the base template (WhatsApp digest off), then fuel logs are switched off.
const SHENALY_TENANT_ID = DEMO_TENANT_IDS.shenaly;
const ORG_A = orgIdFor('shenaly');
const ORG_B = orgIdFor('galle-fort');
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };

// Stands in for Clerk: x-test-user and x-test-org are the session's user and active organization.
function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  const orgId = req.get('x-test-org');
  if (!orgId) return next(forbidden('Select an organization first'));
  req.identity = { userId, orgId };
  next();
}
const denyPlatform = (req, res, next) => next(forbidden('Not under test'));

let db;
let platformDb;
let getTenantDb;
let clerk;
let service;
let tenantB;
let vehicleB;
const servers = [];

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function caller(baseUrl) {
  return async (method, path, { user, org, headers } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(user ? { 'x-test-user': user } : {}), ...(org ? { 'x-test-org': org } : {}), ...headers }
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
}

let app; // createApp, as server.js builds it
let probe; // createTenantRouter plus stand-in routes under /probe that exercise the chain

before(async () => {
  db = await startTestDb();
  ({ platformDb, getTenantDb } = db);
  await seedDemoTenants(platformDb.models);
  clerk = createFakeClerk();
  service = createPlatformService({ platformDb, getTenantDb, clerk });

  // Provisioning initializes tenant B's database; the seeded Shenaly's is initialized here.
  ({ tenant: tenantB } = await service.createTenant(
    {
      name: 'Galle Fort Drives',
      slug: 'galle-fort',
      template: 'base',
      adminEmail: 'owner@gallefort.example',
      limits: { maxVehicles: 10, maxUsers: 3, storageGb: 2 }
    },
    ADMIN
  ));
  const active = await service.getActiveConfig(tenantB.id);
  const config = structuredClone(active.config);
  config.modules.fuelLogs.enabled = false;
  await service.publishConfig(tenantB.id, { config, note: 'Switch fuel logs off', baseVersion: active.version }, ADMIN);

  const dbA = getTenantDb(`tenant_${SHENALY_TENANT_ID}`);
  const dbB = getTenantDb(tenantB.dbName);
  await initTenantDb(dbA);
  await dbA.models.Member.insertMany([
    { clerkUserId: 'user_a_owner', email: 'owner@a.example', name: 'Ava Owner', roleKey: 'owner' },
    { clerkUserId: 'user_a_staff', email: 'staff@a.example', name: 'Sam Staff', roleKey: 'staff' },
    { clerkUserId: 'user_a_removed', email: 'gone@a.example', roleKey: 'staff', status: 'removed' },
    { clerkUserId: 'user_a_orphan', email: 'orphan@a.example', roleKey: 'front_desk' }
  ]);
  await dbB.models.Member.create({ clerkUserId: 'user_b_owner', email: 'owner@b.example', roleKey: 'owner' });
  const [vehicleA] = await dbA.models.Vehicle.create([
    { plateNumber: 'WP A-0001', make: 'Toyota', model: 'Axio', year: 2021, dailyRate: 14000, depositAmount: 35000 }
  ]);
  [vehicleB] = await dbB.models.Vehicle.create([
    { plateNumber: 'B-0001', make: 'Honda', model: 'Fit', year: 2020, dailyRate: 60, depositAmount: 200 }
  ]);
  await dbA.models.FuelLog.create({ vehicle: vehicleA._id, liters: 36, totalCost: 14904 });
  await dbB.models.FuelLog.create({ vehicle: vehicleB._id, liters: 30, totalCost: 52 });

  app = caller(await listen(createApp({ platformAuth: denyPlatform, tenantAuth: stubTenantAuth, platformDb, clerk })));

  const router = createTenantRouter({ tenantAuth: stubTenantAuth, platformDb, getTenantDb, directory: service, cacheTtlMs: 0 });
  const vehiclesRead = [requireModule('vehicles'), requirePermission('vehicles:read')];
  router.get('/probe/vehicles', vehiclesRead, handle((req) => req.models.Vehicle.find().lean()));
  router.get(
    '/probe/vehicles/:id',
    vehiclesRead,
    handle(async (req) => {
      const vehicle = await req.models.Vehicle.findById(req.params.id).lean();
      if (!vehicle) throw notFound('Vehicle not found');
      return vehicle;
    })
  );
  router.get('/probe/fuel-logs', requireModule('fuelLogs'), requirePermission('fuel:read'), handle((req) => req.models.FuelLog.find().lean()));
  router.delete('/probe/costs/:id', requireModule('costs'), requirePermission('costs:delete'), handle(() => ({ deleted: true })));
  probe = caller(await listen(express().use('/api/v1', router).use(errorHandler)));
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await db?.stop();
});

const A_OWNER = { user: 'user_a_owner', org: ORG_A };
const A_STAFF = { user: 'user_a_staff', org: ORG_A };
const B_OWNER = { user: 'user_b_owner', org: ORG_B };

describe('tenant API', () => {
  it('requires a session with an active organization', async () => {
    assert.equal((await app('GET', '/api/v1/me')).status, 401);
    const noOrg = await app('GET', '/api/v1/me', { user: 'user_a_owner' });
    assert.equal(noOrg.status, 403);
    assert.equal(noOrg.body.error.code, 'forbidden');
  });

  it('returns the caller, their tenant, role and effective permissions', async () => {
    const owner = await app('GET', '/api/v1/me', A_OWNER);
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body.tenant, { id: SHENALY_TENANT_ID, name: 'Shenaly Rent a Car', slug: 'shenaly' });
    assert.equal(owner.body.user.name, 'Ava Owner');
    assert.deepEqual(owner.body.role, { key: 'owner', name: 'Owner', system: true });
    assert.equal(owner.body.configVersion, (await service.getActiveConfig(SHENALY_TENANT_ID)).version);
    assert.ok(owner.body.permissions.includes('financials:view'));

    const staff = await app('GET', '/api/v1/me', A_STAFF);
    assert.equal(staff.body.role.key, 'staff');
    assert.ok(staff.body.permissions.includes('rentals:create'));
    assert.ok(!staff.body.permissions.includes('financials:view'));
  });

  it("drops permissions of modules the tenant's config disables", async () => {
    const { body } = await app('GET', '/api/v1/me', B_OWNER);
    assert.ok(body.permissions.includes('costs:delete'));
    for (const permission of ['fuel:read', 'fuel:create', 'whatsapp:view']) assert.ok(!body.permissions.includes(permission), permission);
  });

  it('serves the active config with an ETag', async () => {
    const first = await app('GET', '/api/v1/config', A_OWNER);
    assert.equal(first.status, 200);
    assert.equal(first.body.version, (await service.getActiveConfig(SHENALY_TENANT_ID)).version);
    assert.equal(first.body.config.branding.displayName, 'Shenaly Rent a Car');
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');

    // fetch adds "Cache-Control: no-cache" (forcing a full response) unless the request sets Cache-Control itself.
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const revalidated = await app('GET', '/api/v1/config', { ...A_OWNER, headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } });
    assert.equal(revalidated.status, 304);
  });

  it("refuses organizations that aren't active tenants", async () => {
    const cases = [
      ['org_unknown', /isn't set up/],
      [orgIdFor('coastal-drive'), /suspended/],
      [orgIdFor('kandy-hill'), /provisioning/]
    ];
    for (const [org, message] of cases) {
      const { status, body } = await app('GET', '/api/v1/me', { user: 'user_a_owner', org });
      assert.equal(status, 403, org);
      assert.match(body.error.message, message);
    }
  });

  it("refuses users who aren't active members with an existing role", async () => {
    for (const user of ['user_b_owner', 'user_a_removed', 'user_a_orphan']) {
      assert.equal((await app('GET', '/api/v1/me', { user, org: ORG_A })).status, 403, user);
    }
  });
});

describe('tenant isolation and enforcement (Phase 1 exit criteria)', () => {
  it('an org A token reads only org A data', async () => {
    const a = await probe('GET', '/api/v1/probe/vehicles', A_OWNER);
    const b = await probe('GET', '/api/v1/probe/vehicles', B_OWNER);
    assert.deepEqual(a.body.map((v) => v.plateNumber), ['WP A-0001']);
    assert.deepEqual(b.body.map((v) => v.plateNumber), ['B-0001']);
  });

  it("an org A token can't fetch an org B record by id", async () => {
    assert.equal((await probe('GET', `/api/v1/probe/vehicles/${vehicleB.id}`, A_OWNER)).status, 404);
    assert.equal((await probe('GET', `/api/v1/probe/vehicles/${vehicleB.id}`, B_OWNER)).status, 200);
  });

  it("an org B member can't use their session against org A", async () => {
    assert.equal((await probe('GET', '/api/v1/probe/vehicles', { user: 'user_b_owner', org: ORG_A })).status, 403);
  });

  it('a disabled module returns 404, even for an owner', async () => {
    const disabled = await probe('GET', '/api/v1/probe/fuel-logs', B_OWNER);
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.error.code, 'not_found');
    assert.equal((await probe('GET', '/api/v1/probe/fuel-logs', A_OWNER)).body.length, 1);
  });

  it('a missing permission returns 403', async () => {
    const staff = await probe('DELETE', '/api/v1/probe/costs/123', A_STAFF);
    assert.equal(staff.status, 403);
    assert.match(staff.body.error.message, /costs:delete/);
    assert.equal((await probe('DELETE', '/api/v1/probe/costs/123', A_OWNER)).status, 200);
  });

  it('a published config change applies to the next request', async () => {
    const publish = async (enabled) => {
      const active = await service.getActiveConfig(tenantB.id);
      const config = structuredClone(active.config);
      config.modules.fuelLogs.enabled = enabled;
      await service.publishConfig(tenantB.id, { config, note: `Fuel logs ${enabled ? 'on' : 'off'}`, baseVersion: active.version }, ADMIN);
    };
    await publish(true);
    assert.equal((await probe('GET', '/api/v1/probe/fuel-logs', B_OWNER)).status, 200);
    await publish(false);
    assert.equal((await probe('GET', '/api/v1/probe/fuel-logs', B_OWNER)).status, 404);
  });

  it('refuses unknown modules and permissions when routes are defined', () => {
    assert.throws(() => requireModule('fuel'), /Unknown module/);
    assert.throws(() => requirePermission('costs:remove'), /Unknown permission/);
  });
});

describe('tenant databases', () => {
  it('registers tenant models only on tenant connections', () => {
    assert.deepEqual(Object.keys(mongoose.models), []);
    assert.deepEqual(Object.keys(platformDb.models).sort(), [...PLATFORM_MODEL_NAMES].sort());
    assert.deepEqual(Object.keys(getTenantDb(tenantB.dbName).models).sort(), [...TENANT_MODEL_NAMES].sort());
  });

  it('returns one cached connection per tenant and refuses non-tenant names', () => {
    assert.equal(getTenantDb(tenantB.dbName), getTenantDb(tenantB.dbName));
    assert.notEqual(getTenantDb(tenantB.dbName), getTenantDb(`tenant_${SHENALY_TENANT_ID}`));
    for (const name of ['platform', 'admin', 'tenant_../platform', 'tenant_']) {
      assert.throws(() => getTenantDb(name), /Not a tenant database name/, name);
    }
  });

  it('initTenantDb is idempotent and restores system roles', async () => {
    const db = getTenantDb(tenantB.dbName);
    await db.models.Role.updateOne({ key: 'owner' }, { $set: { permissions: ['dashboard:view'] } });
    await initTenantDb(db);
    const roles = await db.models.Role.find({ system: true }).lean();
    assert.deepEqual(roles.map((r) => r.key).sort(), SYSTEM_ROLES.map((r) => r.key).sort());
    assert.deepEqual(roles.find((r) => r.key === 'owner').permissions, SYSTEM_ROLES[0].permissions);
  });

  it('builds unique indexes, scoped to each tenant', async () => {
    const duplicate = { plateNumber: 'B-0001', make: 'Honda', model: 'Fit', year: 2020, dailyRate: 60, depositAmount: 200 };
    await assert.rejects(getTenantDb(tenantB.dbName).models.Vehicle.create(duplicate), { code: 11000 });
    const copy = await getTenantDb(`tenant_${SHENALY_TENANT_ID}`).models.Vehicle.create(duplicate);
    await copy.deleteOne();
  });

  it('counters are atomic and separate per tenant', async () => {
    const { Counter } = getTenantDb(`tenant_${SHENALY_TENANT_ID}`).models;
    const numbers = await Promise.all([1, 2, 3].map(() => Counter.next('rental:2026')));
    assert.deepEqual(numbers.sort(), [1, 2, 3]);
    assert.equal(await getTenantDb(tenantB.dbName).models.Counter.next('rental:2026'), 1);
  });

  it('rolls back tenant writes in an aborted transaction', async () => {
    const db = getTenantDb(tenantB.dbName);
    await assert.rejects(
      db.transaction(async (session) => {
        await db.models.Counter.next('receipt:2026', { session });
        throw new Error('abort');
      }),
      /abort/
    );
    assert.equal(await db.models.Counter.exists({ _id: 'receipt:2026' }), null);
  });
});

describe('resolveTenant cache', () => {
  it('reuses a lookup for cacheTtlMs, and never caches a miss', async () => {
    let clock = 0;
    let lookups = 0;
    const found = {
      tenant: { id: 't1', name: 'T', slug: 'tee', status: 'active', dbName: 'tenant_t1t1t1t1' },
      activeConfig: { version: 1, config: {} }
    };
    const directory = {
      findTenantByClerkOrgId: (orgId) => {
        lookups += 1;
        return orgId === 'org_1' ? found : null;
      }
    };
    const middleware = resolveTenant({ directory, getTenantDb: () => ({ models: {} }), cacheTtlMs: 1000, now: () => clock });
    const run = (orgId) =>
      new Promise((resolve) => middleware({ identity: { orgId } }, {}, (error) => resolve(error)));

    assert.equal(await run('org_1'), undefined);
    clock = 999;
    await run('org_1');
    assert.equal(lookups, 1);
    clock = 1000;
    await run('org_1');
    assert.equal(lookups, 2);

    assert.equal((await run('org_2')).status, 403);
    await run('org_2');
    assert.equal(lookups, 4);
  });
});

describe('app wiring', () => {
  it('reports the database in the health check', async () => {
    assert.equal((await app('GET', '/api/health')).body.database, 'connected');
  });

  it('responds 503 when /api/v1 has no database, an unreachable one, or no Clerk keys', async () => {
    const noDb = caller(await listen(createApp({ platformAuth: denyPlatform, tenantAuth: stubTenantAuth })));
    assert.equal((await noDb('GET', '/api/v1/me', A_OWNER)).body.error.code, 'database_not_configured');

    // A connection that was never opened stands in for an unreachable database.
    const idle = mongoose.createConnection();
    registerPlatformModels(idle);
    const down = caller(await listen(createApp({ platformAuth: denyPlatform, tenantAuth: stubTenantAuth, platformDb: idle, clerk })));
    const unavailable = await down('GET', '/api/v1/me', A_OWNER);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'database_unavailable');

    const noClerk = caller(await listen(createApp({ platformAuth: denyPlatform, tenantAuth: createTenantAuth({}), platformDb, clerk })));
    assert.equal((await noClerk('GET', '/api/v1/me')).body.error.code, 'auth_not_configured');
  });
});
