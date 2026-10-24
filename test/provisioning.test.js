const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createPlatformService } = require('../src/platform/service');
const { SYSTEM_ROLES } = require('../src/platform/rbac/permissions');
const { PROVISIONING_STEPS } = require('../src/platform/tenants/rules');
const { STALE_AFTER_MS } = require('../src/platform/provisioning');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const limits = { maxVehicles: 50, maxUsers: 10, storageGb: 5 };

function stubAuth(req, res, next) {
  req.actor = ADMIN;
  next();
}

let db;
let clerk;
let server;
let baseUrl;

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

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const create = (slug, overrides = {}) =>
  call('POST', '/tenants', { name: `Tenant ${slug}`, slug, template: 'base', adminEmail: `owner@${slug}.example`, limits, ...overrides });

const stepStatuses = (job) => Object.fromEntries(job.steps.map((s) => [s.key, s.status]));

describe('provisioning', () => {
  it('creates the Clerk org, tenant DB with roles, config v1 and Owner invitation (Phase 2 exit criteria)', async () => {
    const { status, body } = await create('shenaly', {
      name: 'Shenaly Rent a Car',
      template: 'sri-lanka',
      adminEmail: 'Admin@ShenalyRentACar.com',
      adminName: 'Dinuka Silva'
    });
    assert.equal(status, 201);
    const { tenant, job } = body;
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.steps.map((s) => [s.key, s.status]), PROVISIONING_STEPS.map((s) => [s.key, 'done']));
    assert.equal(tenant.status, 'active');
    assert.equal(tenant.dbName, `tenant_${tenant.id}`);
    assert.equal(tenant.activeConfigVersion, 1);

    // Clerk organization, linked both ways, and the invitation.
    const organization = clerk.organizations.get('shenaly');
    assert.equal(tenant.clerkOrgId, organization.id);
    assert.deepEqual(organization.publicMetadata, { tenantId: tenant.id });
    assert.equal(organization.name, 'Shenaly Rent a Car');
    assert.deepEqual(
      clerk.invitations
        .filter((i) => i.organizationId === organization.id)
        .map(({ emailAddress, role, publicMetadata, status }) => ({ emailAddress, role, publicMetadata, status })),
      [{ emailAddress: 'admin@shenalyrentacar.com', role: 'org:admin', publicMetadata: { roleKey: 'owner' }, status: 'pending' }]
    );

    // Tenant database with system roles and indexes.
    const tenantDb = db.getTenantDb(tenant.dbName);
    const roles = await tenantDb.models.Role.find().lean();
    assert.deepEqual(roles.map((r) => r.key).sort(), SYSTEM_ROLES.map((r) => r.key).sort());
    assert.ok((await tenantDb.models.Vehicle.listIndexes()).some((index) => index.name === 'plateNumber_1'));

    // Config v1 from the template, with the name and limits from the form.
    const active = (await call('GET', `/tenants/${tenant.id}/config`)).body;
    assert.equal(active.version, 1);
    assert.equal(active.note, 'Initial config from the sri-lanka template');
    assert.equal(active.config.branding.displayName, 'Shenaly Rent a Car');
    assert.equal(active.config.locale.currency, 'LKR');
    assert.deepEqual(active.config.limits, limits);
    assert.equal(active.createdBy.name, 'Provisioning job');
  });

  it('stops at a failed step and resumes there on retry, repeating nothing', async () => {
    clerk.failOnce('org:clerk-down');
    const created = await create('clerk-down');
    assert.equal(created.status, 201);
    const { tenant, job } = created.body;
    assert.equal(job.status, 'failed');
    assert.deepEqual(stepStatuses(job), {
      create_tenant_record: 'done',
      create_clerk_org: 'failed',
      init_database: 'pending',
      write_config: 'pending',
      invite_admin: 'pending',
      activate: 'pending'
    });
    assert.equal(job.steps[1].error, 'Clerk is unavailable (fake)');
    assert.equal(tenant.status, 'provisioning');
    assert.equal(tenant.clerkOrgId, null);
    assert.equal(tenant.activeConfigVersion, null);
    assert.equal((await call('GET', `/tenants/${tenant.id}/config`)).body, null);
    assert.ok((await call('GET', '/stats')).body.failedProvisioning >= 1);

    const retried = await call('POST', `/tenants/${tenant.id}/provisioning/retry`);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, 'succeeded');
    assert.equal((await call('GET', `/tenants/${tenant.id}`)).body.status, 'active');
    assert.equal((await call('POST', `/tenants/${tenant.id}/provisioning/retry`)).status, 422);
  });

  it("doesn't recreate the Clerk org when only the invitation failed", async () => {
    const createdBefore = clerk.calls.createOrganization;
    const { tenant, job } = (await create('bad-invite', { adminEmail: 'owner@x.fail.test' })).body;
    assert.equal(stepStatuses(job).invite_admin, 'failed');
    assert.match(job.steps.find((s) => s.key === 'invite_admin').error, /suppression list/);
    assert.equal(tenant.activeConfigVersion, 1);

    assert.equal((await call('POST', `/tenants/${tenant.id}/provisioning/retry`)).body.status, 'succeeded');
    assert.equal(clerk.calls.createOrganization, createdBefore + 1);
    assert.equal(clerk.invitations.filter((i) => i.emailAddress === 'owner@x.fail.test').length, 1);
    const [entry] = (await call('GET', `/audit?tenantId=${tenant.id}&limit=1`)).body;
    assert.equal(entry.action, 'tenant.provisioning_retried');
    assert.equal(entry.summary, 'Retried failed steps; tenant activated');
  });

  it('records the failure again when a retry fails', async () => {
    clerk.failOnce('org:down-twice');
    const { tenant } = (await create('down-twice')).body;
    clerk.failOnce('org:down-twice');
    const retried = await call('POST', `/tenants/${tenant.id}/provisioning/retry`);
    assert.equal(retried.body.status, 'failed');
    assert.equal(retried.body.steps[1].error, 'Clerk is unavailable (fake)');
    const [entry] = (await call('GET', `/audit?tenantId=${tenant.id}&limit=1`)).body;
    assert.match(entry.summary, /^Retried; stopped again at "Create Clerk organization"/);
  });

  it('runs a job once when two retries arrive together', async () => {
    const slow = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk: createFakeClerk({ latencyMs: 50 }) });
    const { tenant } = await slow.createTenant({ name: 'Twin Retry', slug: 'twin-retry', template: 'base', adminEmail: 'o@twin.fail.test', limits }, ADMIN);
    const results = await Promise.allSettled([slow.retryProvisioning(tenant.id, ADMIN), slow.retryProvisioning(tenant.id, ADMIN)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'fulfilled').value.status, 'succeeded');
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  });

  it('retries a job cut off mid-run, but not one that is still running', async () => {
    const { ProvisioningJob } = db.platformDb.models;
    const { tenant } = (await create('cut-off', { adminEmail: 'o@cut-off.fail.test' })).body;

    await ProvisioningJob.updateOne({ tenantId: tenant.id }, { $set: { status: 'running', heartbeatAt: new Date() } });
    assert.equal((await call('POST', `/tenants/${tenant.id}/provisioning/retry`)).status, 409);

    await ProvisioningJob.updateOne({ tenantId: tenant.id }, { $set: { heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000) } });
    assert.equal((await call('POST', `/tenants/${tenant.id}/provisioning/retry`)).body.status, 'succeeded');
  });

  it("fails clearly when another tenant's Clerk organization has the slug", async () => {
    clerk.organizations.set('taken', { id: 'org_taken', name: 'Someone else', slug: 'taken', publicMetadata: { tenantId: 'another' } });
    const { job } = (await create('taken')).body;
    assert.equal(stepStatuses(job).create_clerk_org, 'failed');
    assert.match(job.steps[1].error, /already used by another organization/);
  });

  it('lets only one of two concurrent creates take a slug', async () => {
    const results = await Promise.all([create('same-slug'), create('same-slug')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });
});

describe('platform storage', () => {
  it('settles two publishes from the same base version: one wins, one conflicts', async () => {
    const { tenant } = (await create('race')).body;
    const active = (await call('GET', `/tenants/${tenant.id}/config`)).body;
    const publish = (maxVehicles) => {
      const config = structuredClone(active.config);
      config.limits.maxVehicles = maxVehicles;
      return call('POST', `/tenants/${tenant.id}/config`, { config, note: `Set ${maxVehicles} vehicles`, baseVersion: active.version });
    };
    const results = await Promise.all([publish(60), publish(70)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);

    const versions = (await call('GET', `/tenants/${tenant.id}/config/versions`)).body;
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
    const winner = results.find((r) => r.status === 201).body;
    assert.equal((await call('GET', `/tenants/${tenant.id}`)).body.limits.maxVehicles, winner.config.limits.maxVehicles);
  });

  it('keeps tenants across service instances (nothing lives in memory)', async () => {
    const fresh = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
    const slugs = (await fresh.listTenants()).map((t) => t.slug);
    assert.ok(slugs.includes('shenaly'));
    assert.equal((await fresh.findTenantByClerkOrgId(orgIdFor('shenaly'))).tenant.slug, 'shenaly');
  });
});
