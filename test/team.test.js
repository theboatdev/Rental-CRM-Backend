const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTenantRouter, OPEN_ROUTES } = require('../src/routes/tenant');
const { handle } = require('../src/routes/handle');
const { errorHandler } = require('../src/middleware/errorHandler');
const { requirePermission } = require('../src/middleware/tenantContext');
const { createPlatformService } = require('../src/platform/service');
const { stripFinancialFields } = require('../src/platform/rbac/financialFields');
const { SYSTEM_ROLES } = require('../src/platform/rbac/permissions');
const { forbidden, unauthenticated } = require('../src/platform/errors');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

// One tenant (base template: WhatsApp digest off) with an Owner, a Manager and a Staff member.
const ORG = orgIdFor('galle-fort');
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: req.get('x-test-org') };
  if (!req.identity.orgId) return next(forbidden('Select an organization first'));
  next();
}

let db;
let clerk;
let service;
let tenant;
let Member;
let server;
let baseUrl;

const as = (user) => async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-org': ORG },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const owner = as('user_owner');
const manager = as('user_manager');
const staff = as('user_staff');

const idOf = async (clerkUserId) => String((await Member.findOne({ clerkUserId }).lean())._id);
const roleOf = async (clerkUserId) => (await Member.findOne({ clerkUserId }).lean()).roleKey;
const addMember = (clerkUserId, roleKey, name) => Member.create({ clerkUserId, email: `${clerkUserId}@gallefort.example`, name, roleKey });

async function setMaxUsers(maxUsers) {
  const active = await service.getActiveConfig(tenant.id);
  const config = structuredClone(active.config);
  config.limits.maxUsers = maxUsers;
  await service.publishConfig(tenant.id, { config, note: `Allow ${maxUsers} users`, baseVersion: active.version }, ADMIN);
}

const tenantRouter = () =>
  createTenantRouter({ tenantAuth: stubTenantAuth, platformDb: db.platformDb, getTenantDb: db.getTenantDb, directory: service, clerk, cacheTtlMs: 0 });

before(async () => {
  db = await startTestDb();
  clerk = createFakeClerk();
  service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
  ({ tenant } = await service.createTenant(
    { name: 'Galle Fort Drives', slug: 'galle-fort', template: 'base', adminEmail: 'owner@gallefort.example', limits: { maxVehicles: 10, maxUsers: 20, storageGb: 2 } },
    ADMIN
  ));
  ({ Member } = db.getTenantDb(tenant.dbName).models);
  await addMember('user_owner', 'owner', 'Ava Owner');
  await addMember('user_manager', 'manager', 'Max Manager');
  await addMember('user_staff', 'staff', 'Sam Staff');

  const router = tenantRouter();
  // Stands in for a Phase 4 dashboard route that returns profit figures.
  router.get(
    '/probe/finance',
    requirePermission('dashboard:view'),
    handle(() => ({ vehicle: 'WP CAH-4821', rentals: 3, revenue: 100000, profit: 40000, profitMargin: 0.4, byMonth: [{ month: '2026-10', revenue: 100000, roi: 1.2 }] }))
  );
  server = express().use(express.json()).use('/api/v1', router).use(errorHandler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe('route guards', () => {
  it('checks a permission on every tenant route except /me and /config', () => {
    const routes = tenantRouter().stack.filter((layer) => layer.route);
    assert.ok(routes.length > OPEN_ROUTES.length);
    for (const { route } of routes) {
      if (OPEN_ROUTES.includes(route.path)) continue;
      const guarded = route.stack.some((layer) => layer.handle.requiredPermissions?.length);
      assert.ok(guarded, `${Object.keys(route.methods).join(',').toUpperCase()} ${route.path} has no requirePermission`);
    }
  });

  it('rejects malformed input instead of passing it to MongoDB', async () => {
    assert.equal((await owner('GET', '/members?status[$ne]=x')).status, 422);
    assert.equal((await owner('GET', '/members?status=constructor')).status, 422);
    assert.equal((await owner('PATCH', `/members/${await idOf('user_staff')}`, { roleKey: { $ne: null } })).status, 422);
    assert.equal((await owner('PATCH', '/members/not-an-id', { roleKey: 'staff' })).status, 404);
    assert.equal((await owner('POST', '/invitations', { email: { $gt: '' }, roleKey: 'staff' })).status, 422);
    assert.equal(await roleOf('user_staff'), 'staff');
  });
});

describe('members and invitations', () => {
  it('lists the active team for members with team:read', async () => {
    const { status, body } = await owner('GET', '/members');
    assert.equal(status, 200);
    assert.deepEqual(body.map((m) => [m.name, m.roleKey, m.status]), [
      ['Ava Owner', 'owner', 'active'],
      ['Max Manager', 'manager', 'active'],
      ['Sam Staff', 'staff', 'active']
    ]);
    assert.equal((await manager('GET', '/members')).status, 200);
    assert.equal((await staff('GET', '/members')).status, 403);
  });

  it('invites by email with a role, as org:member or (for Owners) org:admin', async () => {
    const { status, body } = await owner('POST', '/invitations', { email: 'New.Hire@Example.com', roleKey: 'staff' });
    assert.equal(status, 201);
    assert.equal(body.email, 'new.hire@example.com');
    assert.equal(body.roleKey, 'staff');
    assert.equal(clerk.invitations.at(-1).role, 'org:member');

    await owner('POST', '/invitations', { email: 'co-owner@example.com', roleKey: 'owner' });
    assert.equal(clerk.invitations.at(-1).role, 'org:admin');
    // The first one is the admin invitation provisioning sent.
    assert.deepEqual((await manager('GET', '/invitations')).body.map((i) => i.email), [
      'owner@gallefort.example',
      'new.hire@example.com',
      'co-owner@example.com'
    ]);
  });

  it('refuses duplicate invitations, existing members, unknown roles and callers without team:manage', async () => {
    assert.equal((await owner('POST', '/invitations', { email: 'new.hire@example.com', roleKey: 'staff' })).status, 409);
    assert.equal((await owner('POST', '/invitations', { email: 'user_staff@gallefort.example', roleKey: 'staff' })).status, 409);
    const unknown = await owner('POST', '/invitations', { email: 'x@example.com', roleKey: 'no_such_role' });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.issues[0].path, 'roleKey');
    assert.equal((await manager('POST', '/invitations', { email: 'x@example.com', roleKey: 'staff' })).status, 403);
  });

  it('enforces limits.maxUsers, counting pending invitations', async () => {
    const pending = (await owner('GET', '/invitations')).body;
    await setMaxUsers(3 + pending.length); // exactly full: 3 members plus the pending invitations
    try {
      const full = await owner('POST', '/invitations', { email: 'one-more@example.com', roleKey: 'staff' });
      assert.equal(full.status, 409);
      assert.match(full.body.error.message, new RegExp(`allows ${3 + pending.length} users`));

      const coOwner = pending.find((i) => i.email === 'co-owner@example.com');
      assert.deepEqual((await owner('DELETE', `/invitations/${coOwner.id}`)).body, { id: coOwner.id, email: 'co-owner@example.com', revoked: true });
      assert.equal((await owner('POST', '/invitations', { email: 'one-more@example.com', roleKey: 'staff' })).status, 201);
      assert.equal((await owner('DELETE', '/invitations/orginv_missing')).status, 404);
    } finally {
      await setMaxUsers(20);
    }
  });

  it("passes Clerk's reason on when Clerk rejects an invitation", async () => {
    clerk.failOnce('invite:bad@example.com');
    const { status, body } = await owner('POST', '/invitations', { email: 'bad@example.com', roleKey: 'staff' });
    assert.equal(status, 422);
    assert.match(body.error.message, /invalid \(fake\)/);
  });
});

describe('role changes and removal', () => {
  it('changes a role, updating the Clerk role only across the Owner boundary', async () => {
    const staffId = await idOf('user_staff');
    const calls = clerk.memberRoles.length;
    assert.equal((await owner('PATCH', `/members/${staffId}`, { roleKey: 'accountant' })).body.roleKey, 'accountant');
    assert.equal(clerk.memberRoles.length, calls);

    await owner('PATCH', `/members/${staffId}`, { roleKey: 'owner' });
    assert.deepEqual(clerk.memberRoles.at(-1), { organizationId: ORG, userId: 'user_staff', role: 'org:admin' });
    await owner('PATCH', `/members/${staffId}`, { roleKey: 'staff' });
    assert.deepEqual(clerk.memberRoles.at(-1), { organizationId: ORG, userId: 'user_staff', role: 'org:member' });
    assert.equal(await roleOf('user_staff'), 'staff');
  });

  it('never leaves the workspace without an Owner', async () => {
    const ownerId = await idOf('user_owner');
    const demote = await owner('PATCH', `/members/${ownerId}`, { roleKey: 'manager' });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error.message, /at least one Owner/);
    assert.equal((await owner('DELETE', `/members/${ownerId}`)).status, 409);
    assert.equal(await roleOf('user_owner'), 'owner');
  });

  it('keeps one Owner when two Owners demote each other at the same time', async () => {
    await owner('PATCH', `/members/${await idOf('user_manager')}`, { roleKey: 'owner' });
    const [a, b] = await Promise.all([
      owner('PATCH', `/members/${await idOf('user_manager')}`, { roleKey: 'manager' }),
      manager('PATCH', `/members/${await idOf('user_owner')}`, { roleKey: 'manager' })
    ]);
    assert.equal(await Member.countDocuments({ roleKey: 'owner', status: 'active' }), 1);
    assert.deepEqual([a.status, b.status].filter((s) => s === 200), [200]);
    // Put the cast back for the next tests.
    await Member.updateOne({ clerkUserId: 'user_owner' }, { $set: { roleKey: 'owner' } });
    await Member.updateOne({ clerkUserId: 'user_manager' }, { $set: { roleKey: 'manager' } });
  });

  it('undoes a role change when Clerk fails', async () => {
    clerk.failOnce('role:user_staff');
    const { status, body } = await owner('PATCH', `/members/${await idOf('user_staff')}`, { roleKey: 'owner' });
    assert.equal(status, 502);
    assert.equal(body.error.code, 'clerk_unavailable');
    assert.equal(await roleOf('user_staff'), 'staff');
  });

  it('removes a member from the tenant and its Clerk organization', async () => {
    await addMember('user_temp', 'staff', 'Tia Temp');
    const { status, body } = await owner('DELETE', `/members/${await idOf('user_temp')}`);
    assert.equal(status, 200);
    assert.equal(body.status, 'removed');
    assert.deepEqual(clerk.removedMembers.at(-1), { organizationId: ORG, userId: 'user_temp' });
    const removed = await Member.findOne({ clerkUserId: 'user_temp' }).lean();
    assert.equal(removed.status, 'removed');
    assert.equal((await db.platformDb.models.Tenant.findById(tenant.id).lean()).usage.members, 3);
    assert.equal((await as('user_temp')('GET', '/me')).status, 403);
    assert.ok((await owner('GET', '/members?status=removed')).body.some((m) => m.clerkUserId === 'user_temp'));
  });

  it('undoes a removal when Clerk fails', async () => {
    await addMember('user_temp2', 'staff', 'Tom Temp');
    clerk.failOnce('remove:user_temp2');
    assert.equal((await owner('DELETE', `/members/${await idOf('user_temp2')}`)).status, 502);
    const member = await Member.findOne({ clerkUserId: 'user_temp2' }).lean();
    assert.equal(member.status, 'active');
    assert.equal(member.removedAt, undefined);
  });
});

describe('custom roles', () => {
  it('lists system roles first with member counts, and the permission catalog', async () => {
    const roles = (await manager('GET', '/roles')).body;
    assert.deepEqual(roles.slice(0, 4).map((r) => r.key), SYSTEM_ROLES.map((r) => r.key));
    assert.equal(roles.find((r) => r.key === 'owner').memberCount, 1);
    const catalog = (await manager('GET', '/permissions')).body;
    assert.equal(catalog.find((p) => p.key === 'whatsapp:view').available, false);
    assert.equal(catalog.find((p) => p.key === 'vehicles:read').available, true);
    assert.equal((await staff('GET', '/roles')).status, 403);
  });

  it('creates a role, validated by CustomRoleInputSchema', async () => {
    const input = {
      key: 'front_desk',
      name: 'Front desk',
      description: 'Counter staff who also onboard colleagues',
      permissions: ['renters:read', 'renters:create', 'renters:create', 'team:read', 'team:manage', 'fuel:read']
    };
    const created = await owner('POST', '/roles', input);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.permissions, ['renters:read', 'renters:create', 'team:read', 'team:manage', 'fuel:read']);
    assert.equal(created.body.system, false);

    assert.equal((await owner('POST', '/roles', { ...input, key: 'staff' })).status, 409);
    const badKey = await owner('POST', '/roles', { ...input, key: 'Front Desk' });
    assert.equal(badKey.status, 422);
    assert.equal(badKey.body.error.issues[0].path, 'key');
    const badPermission = await owner('POST', '/roles', { ...input, key: 'other', permissions: ['renters:destroy'] });
    assert.equal(badPermission.body.error.issues[0].path, 'permissions[0]');
    assert.equal((await manager('POST', '/roles', { ...input, key: 'other' })).status, 403);
  });

  it('edits a custom role but never a system role', async () => {
    const { status, body } = await owner('PATCH', '/roles/front_desk', { permissions: ['renters:read', 'renters:create', 'team:read', 'team:manage'] });
    assert.equal(status, 200);
    assert.equal(body.description, 'Counter staff who also onboard colleagues');
    assert.ok(!body.permissions.includes('fuel:read'));
    assert.equal((await owner('PATCH', '/roles/staff', { name: 'Crew' })).status, 422);
    assert.equal((await owner('PATCH', '/roles/nobody', { name: 'Crew' })).status, 404);
    assert.equal((await owner('PATCH', '/roles/front_desk', { key: 'renamed' })).status, 422);
  });

  it("doesn't let a custom role hand out more than it has", async () => {
    await addMember('user_desk', 'front_desk', 'Dee Desk');
    const desk = as('user_desk');
    const managerRole = await desk('POST', '/invitations', { email: 'mgr@example.com', roleKey: 'manager' });
    assert.equal(managerRole.status, 403);
    assert.match(managerRole.body.error.message, /permissions you don't have/);
    assert.equal((await desk('POST', '/invitations', { email: 'desk2@example.com', roleKey: 'front_desk' })).status, 201);

    await addMember('user_desk_peer', 'front_desk', 'Pat Peer');
    assert.match((await desk('PATCH', `/members/${await idOf('user_desk_peer')}`, { roleKey: 'owner' })).body.error.message, /Only an Owner/);
    assert.match((await desk('PATCH', `/members/${await idOf('user_staff')}`, { roleKey: 'front_desk' })).body.error.message, /permissions you don't have/);
    assert.equal((await desk('PATCH', `/members/${await idOf('user_manager')}`, { roleKey: 'front_desk' })).status, 403);
    assert.equal((await desk('DELETE', `/members/${await idOf('user_owner')}`)).status, 403);

    await owner('POST', '/roles', { key: 'role_editor', name: 'Role editor', permissions: ['roles:manage', 'team:read', 'renters:read'] });
    await addMember('user_editor', 'role_editor', 'Ed Editor');
    const editor = as('user_editor');
    assert.equal((await editor('POST', '/roles', { key: 'voider', name: 'Voider', permissions: ['payments:void'] })).status, 403);
    assert.equal((await editor('POST', '/roles', { key: 'reader', name: 'Reader', permissions: ['renters:read'] })).status, 201);
    assert.equal((await editor('PATCH', '/roles/front_desk', { name: 'Desk' })).status, 403);
  });

  it('deletes a role only when no member or pending invitation uses it', async () => {
    const inUse = await owner('DELETE', '/roles/front_desk');
    assert.equal(inUse.status, 409);
    assert.match(inUse.body.error.message, /^2 members have this role/);

    await owner('POST', '/roles', { key: 'seasonal', name: 'Seasonal', permissions: ['renters:read'] });
    const invitation = (await owner('POST', '/invitations', { email: 'summer@example.com', roleKey: 'seasonal' })).body;
    assert.match((await owner('DELETE', '/roles/seasonal')).body.error.message, /pending invitation/);
    await owner('DELETE', `/invitations/${invitation.id}`);
    assert.deepEqual((await owner('DELETE', '/roles/seasonal')).body, { key: 'seasonal', deleted: true });
    assert.equal((await owner('DELETE', '/roles/owner')).status, 422);
  });
});

describe('field-level filtering', () => {
  it('drops profit and margin fields at any depth, leaving other values alone', () => {
    const at = new Date(0);
    assert.deepEqual(stripFinancialFields({ amount: 1, profit: 2, at, rows: [{ margin: 3, revenue: 4, ok: 5 }] }), { amount: 1, at, rows: [{ ok: 5 }] });
  });

  it('hides them from members without financials:view', async () => {
    assert.deepEqual((await staff('GET', '/probe/finance')).body, { vehicle: 'WP CAH-4821', rentals: 3, byMonth: [{ month: '2026-10' }] });
    const full = (await owner('GET', '/probe/finance')).body;
    assert.equal(full.profit, 40000);
    assert.equal(full.byMonth[0].roi, 1.2);
    await addMember('user_accountant', 'accountant', 'Al Accountant');
    assert.equal((await as('user_accountant')('GET', '/probe/finance')).body.profitMargin, 0.4);
  });
});

describe('tenant audit log', () => {
  it('records team and role changes, newest first, for members with audit:read', async () => {
    const { status, body } = await manager('GET', '/audit?limit=200');
    assert.equal(status, 200);
    const actions = new Set(body.map((e) => e.action));
    for (const action of ['member.invited', 'invitation.revoked', 'member.role_changed', 'member.removed', 'role.created', 'role.updated', 'role.deleted']) {
      assert.ok(actions.has(action), action);
    }
    assert.ok(body.every((e, i) => i === 0 || body[i - 1].at >= e.at));
    assert.ok(body.find((e) => e.action === 'role.updated' && e.entityId === 'front_desk').summary.includes('removed fuel:read'));
    assert.ok((await manager('GET', '/audit?entityType=role')).body.every((e) => e.entityType === 'role'));
    assert.equal((await staff('GET', '/audit')).status, 403);
  });
});
