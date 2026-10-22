const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createPlatformService } = require('../src/platform/service');
const { seedDemoTenants } = require('../src/platform/seed');
const { CONFIG_TEMPLATES } = require('../src/platform/config/templates');

const SHENALY = '6712a4f0c2b1e93d8a0f1b2c';
const KANDY = '6712b9e1d4c3a2f1e0d9c8b7';
const limits = { maxVehicles: 10, maxUsers: 3, storageGb: 2 };

// Stands in for Clerk: the x-test-role header decides who is calling.
function stubAuth(req, res, next) {
  const role = req.get('x-test-role');
  if (!role) return res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in required' } });
  if (role !== 'super_admin') return res.status(403).json({ error: { code: 'forbidden', message: 'Super admin access required' } });
  req.actor = { id: 'user_test', name: 'Test Admin' };
  next();
}

let server;
let baseUrl;

before(async () => {
  const app = createApp({ platformAuth: stubAuth, service: createPlatformService({ seed: seedDemoTenants }) });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/platform`;
});

after(() => server.close());

async function call(method, path, body, role = 'super_admin') {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

describe('platform API', () => {
  it('requires a super admin', async () => {
    assert.equal((await call('GET', '/tenants', undefined, null)).status, 401);
    assert.equal((await call('GET', '/tenants', undefined, 'tenant_admin')).status, 403);
  });

  it('serves the config contract', async () => {
    const { status, body } = await call('GET', '/meta');
    assert.equal(status, 200);
    assert.ok(body.configJsonSchema.properties.modules);
    assert.deepEqual(body.modules.map((m) => m.key).slice(0, 3), ['dashboard', 'vehicles', 'renters']);
    assert.deepEqual(body.templates.map((t) => t.key), ['base', 'sri-lanka']);
    assert.ok(body.permissions.some((p) => p.key === 'costs:delete'));
    assert.deepEqual(body.systemRoles.map((r) => r.key), ['owner', 'manager', 'staff', 'accountant']);
  });

  it('lists the seeded tenants with allowed transitions', async () => {
    const { body } = await call('GET', '/tenants');
    const shenaly = body.find((t) => t.id === SHENALY);
    assert.equal(shenaly.status, 'active');
    assert.deepEqual(shenaly.allowedTransitions, ['suspended', 'archived']);
    assert.equal((await call('GET', '/stats')).body.tenantsByStatus.provisioning, 1);
  });

  it('creates a tenant and rejects a duplicate slug', async () => {
    const input = { name: 'Galle Fort Drives', slug: 'galle-fort', template: 'sri-lanka', adminEmail: 'a@b.co', limits };
    const created = await call('POST', '/tenants', input);
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant.status, 'active');
    assert.equal(created.body.tenant.dbName, `tenant_${created.body.tenant.id}`);

    const duplicate = await call('POST', '/tenants', input);
    assert.equal(duplicate.status, 409);
  });

  it('reports field issues for an invalid create request', async () => {
    const { status, body } = await call('POST', '/tenants', { name: 'X', slug: 'admin', template: 'nope', adminEmail: 'x', limits });
    assert.equal(status, 422);
    const fields = body.error.issues.map((i) => i.path);
    for (const field of ['name', 'slug', 'template', 'adminEmail']) assert.ok(fields.includes(field), field);
  });

  it('retries a failed provisioning job', async () => {
    const { body } = await call('POST', '/tenants', { name: 'Bad Invite', slug: 'bad-invite', template: 'base', adminEmail: 'o@x.fail.test', limits });
    assert.equal(body.job.status, 'failed');
    assert.equal((await call('PATCH', `/tenants/${body.tenant.id}/status`, { status: 'active' })).status, 422);
    assert.equal((await call('POST', `/tenants/${body.tenant.id}/provisioning/retry`)).body.status, 'succeeded');
    assert.equal((await call('GET', `/tenants/${body.tenant.id}`)).body.status, 'active');
  });

  it('enforces status transitions', async () => {
    assert.equal((await call('PATCH', `/tenants/${SHENALY}/status`, { status: 'suspended' })).status, 200);
    assert.equal((await call('PATCH', `/tenants/${SHENALY}/status`, { status: 'active' })).status, 200);
    assert.equal((await call('PATCH', `/tenants/${KANDY}/status`, { status: 'suspended' })).status, 422);
  });

  it('validates an uploaded config file and diffs it against the active version', async () => {
    const active = (await call('GET', `/tenants/${SHENALY}/config`)).body;
    const edited = structuredClone(active.config);
    edited.modules.fuelLogs.enabled = false;
    edited.lists.costCategories = edited.lists.costCategories.filter((c) => c.key !== 'SUSPENSION');

    const ok = await call('POST', `/tenants/${SHENALY}/config/validate`, { configText: JSON.stringify(edited) });
    assert.equal(ok.body.valid, true);
    assert.ok(ok.body.changes.some((c) => c.path === 'modules.fuelLogs.enabled'));
    assert.deepEqual(ok.body.removedListKeys, [{ list: 'costCategories', key: 'SUSPENSION' }]);

    const syntax = await call('POST', `/tenants/${SHENALY}/config/validate`, { configText: '{ not json' });
    assert.equal(syntax.body.valid, false);
    assert.match(syntax.body.issues[0].message, /^Invalid JSON/);

    edited.locale.currency = 'ABC';
    const bad = await call('POST', `/tenants/${SHENALY}/config/validate`, { config: edited });
    assert.equal(bad.body.valid, false);
    assert.ok(bad.body.issues.some((i) => i.path === 'locale.currency'));
  });

  it('publishes with optimistic concurrency, then restores', async () => {
    const active = (await call('GET', `/tenants/${SHENALY}/config`)).body;
    const edited = structuredClone(active.config);
    edited.limits.maxVehicles = 60;

    const published = await call('POST', `/tenants/${SHENALY}/config`, { config: edited, note: 'Raise vehicle limit', baseVersion: active.version });
    assert.equal(published.status, 201);
    assert.equal(published.body.version, active.version + 1);
    assert.equal((await call('GET', `/tenants/${SHENALY}`)).body.limits.maxVehicles, 60);

    const stale = await call('POST', `/tenants/${SHENALY}/config`, { config: edited, note: 'Stale edit', baseVersion: active.version });
    assert.equal(stale.status, 409);

    const noNote = await call('POST', `/tenants/${SHENALY}/config`, { config: edited, note: '', baseVersion: published.body.version });
    assert.equal(noNote.status, 422);

    const restored = await call('POST', `/tenants/${SHENALY}/config/versions/1/restore`, { baseVersion: published.body.version });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.body.config.modules.whatsappDigest.recipients, []);

    const versions = (await call('GET', `/tenants/${SHENALY}/config/versions`)).body;
    assert.equal(versions[0].version, restored.body.version);
    assert.ok(versions[0].changes.length > 0);
    assert.deepEqual(versions.at(-1).changes, []);
  });

  it('records an audit trail, newest first', async () => {
    const { body } = await call('GET', `/audit?tenantId=${SHENALY}&limit=2`);
    assert.deepEqual(body.map((e) => e.action), ['config.restored', 'config.published']);
    assert.equal(body[0].actor.name, 'Test Admin');
  });

  it('validates any config without a tenant', async () => {
    const { body } = await call('POST', '/config/validate', { config: CONFIG_TEMPLATES.base.config });
    assert.equal(body.valid, true);
  });

  it('returns 404 for unknown tenants', async () => {
    assert.equal((await call('GET', '/tenants/000000000000000000000000')).status, 404);
  });
});
