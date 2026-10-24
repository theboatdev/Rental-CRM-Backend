const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk } = require('./helpers/fakeClerk');

const ADMIN = { id: 'user_super', name: 'Test Admin' };
const limits = { maxVehicles: 10, maxUsers: 5, storageGb: 2 };

function stubAuth(req, res, next) {
  req.actor = ADMIN;
  next();
}

let db;
let clerk;
let server;
let baseUrl;

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const create = async (slug, overrides = {}) =>
  (await call('POST', '/tenants', { name: `Tenant ${slug}`, slug, template: 'base', adminEmail: `owner@${slug}.example`, limits, ...overrides })).body.tenant;

const databaseExists = async (name) => (await db.platformDb.db.admin().listDatabases()).databases.some((d) => d.name === name);

before(async () => {
  db = await startTestDb();
  clerk = createFakeClerk();
  server = createApp({ platformAuth: stubAuth, platformDb: db.platformDb, clerk }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/platform`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('deleting a tenant', () => {
  it('refuses tenants that are still in use, until they are archived', async () => {
    const tenant = await create('in-use');
    const refused = await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'in-use' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /Archive Tenant in-use before deleting it/);
    assert.equal((await call('GET', `/tenants/${tenant.id}`)).status, 200);
  });

  it('needs the slug typed to confirm', async () => {
    const tenant = await create('confirm-me');
    await call('PATCH', `/tenants/${tenant.id}/status`, { status: 'archived' });
    for (const confirmSlug of [undefined, 'confirm', { $ne: null }]) {
      const res = await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.issues[0].path, 'confirmSlug');
    }
  });

  it('deletes the Clerk organization, the database and the platform records, keeping the audit history', async () => {
    const tenant = await create('goodbye');
    const tenantDb = db.getTenantDb(tenant.dbName);
    await tenantDb.models.Vehicle.create({ plateNumber: 'WP GONE-1', make: 'Toyota', model: 'Axio', year: 2020, dailyRate: 1, depositAmount: 0 });
    assert.equal(await databaseExists(tenant.dbName), true);
    await call('PATCH', `/tenants/${tenant.id}/status`, { status: 'archived' });

    const { status, body } = await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'goodbye' });
    assert.equal(status, 200);
    assert.deepEqual(body, { id: tenant.id, deleted: true });

    assert.equal((await call('GET', `/tenants/${tenant.id}`)).status, 404);
    assert.ok(!(await call('GET', '/tenants')).body.some((t) => t.id === tenant.id));
    assert.ok(clerk.deletedOrganizations.includes(tenant.clerkOrgId));
    assert.equal(await databaseExists(tenant.dbName), false);
    const { TenantConfig, ProvisioningJob } = db.platformDb.models;
    assert.equal(await TenantConfig.countDocuments({ tenantId: tenant.id }), 0);
    assert.equal(await ProvisioningJob.countDocuments({ tenantId: tenant.id }), 0);

    const history = (await call('GET', `/audit?tenantId=${tenant.id}`)).body;
    assert.equal(history[0].action, 'tenant.deleted');
    assert.equal(history[0].tenantName, 'Tenant goodbye');
    assert.ok(history.some((e) => e.action === 'tenant.created'));
  });

  it('cleans up a tenant whose provisioning failed, without archiving it first', async () => {
    clerk.failOnce('org:broken');
    const tenant = await create('broken');
    assert.equal(tenant.status, 'provisioning');
    assert.equal(tenant.clerkOrgId, null);
    assert.equal((await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'broken' })).status, 200);
    assert.equal((await call('GET', `/tenants/${tenant.id}`)).status, 404);
  });

  it('keeps everything when Clerk fails, and finishes on a retry', async () => {
    const tenant = await create('flaky');
    await call('PATCH', `/tenants/${tenant.id}/status`, { status: 'archived' });
    clerk.failOnce(`delete-org:${tenant.clerkOrgId}`);
    const failed = await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'flaky' });
    assert.equal(failed.status, 502);
    assert.equal((await call('GET', `/tenants/${tenant.id}`)).body.status, 'archived');
    assert.equal(await databaseExists(tenant.dbName), true);

    assert.equal((await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'flaky' })).status, 200);
    assert.equal(await databaseExists(tenant.dbName), false);
  });

  it('frees the slug for a new tenant', async () => {
    const tenant = await create('reuse-me');
    await call('PATCH', `/tenants/${tenant.id}/status`, { status: 'archived' });
    await call('DELETE', `/tenants/${tenant.id}`, { confirmSlug: 'reuse-me' });
    const again = await create('reuse-me');
    assert.equal(again.status, 'active');
    assert.notEqual(again.id, tenant.id);
  });
});
