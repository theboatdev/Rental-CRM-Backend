const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk } = require('./helpers/fakeClerk');

// A super admin managing a tenant's users from the admin dashboard (/api/platform/tenants/:id/...).
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
let tenant;

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
const users = (path = '') => `/tenants/${tenant.id}${path}`;
const members = () => db.getTenantDb(tenant.dbName).models.Member;
const memberId = async (clerkUserId) => String((await members().findOne({ clerkUserId }).lean())._id);

before(async () => {
  db = await startTestDb();
  clerk = createFakeClerk();
  server = createApp({ platformAuth: stubAuth, platformDb: db.platformDb, clerk }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/platform`;
  ({ tenant } = (await call('POST', '/tenants', { name: 'Shenaly Rent a Car', slug: 'shenaly', template: 'sri-lanka', adminEmail: 'owner@shenaly.example', limits })).body);
  await members().create({ clerkUserId: 'user_owner', email: 'owner@shenaly.example', name: 'Dinuka Silva', roleKey: 'owner' });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.stop();
});

describe("a tenant's users, managed by a super admin", () => {
  it('lists members, roles and the pending invitation provisioning sent', async () => {
    assert.deepEqual((await call('GET', users('/members'))).body.map((m) => [m.email, m.roleKey]), [['owner@shenaly.example', 'owner']]);
    assert.deepEqual((await call('GET', users('/roles'))).body.map((r) => r.key), ['owner', 'manager', 'staff', 'accountant']);
    assert.deepEqual((await call('GET', users('/invitations'))).body.map((i) => [i.email, i.roleKey]), [['owner@shenaly.example', 'owner']]);
  });

  it('invites with any role, including Owner, through a Clerk invitation', async () => {
    const staff = await call('POST', users('/invitations'), { email: 'Kasun@Shenaly.example', roleKey: 'staff' });
    assert.equal(staff.status, 201);
    assert.deepEqual([staff.body.email, staff.body.roleKey], ['kasun@shenaly.example', 'staff']);
    assert.equal(clerk.invitations.at(-1).role, 'org:member');

    const coOwner = await call('POST', users('/invitations'), { email: 'partner@shenaly.example', roleKey: 'owner' });
    assert.equal(coOwner.status, 201);
    assert.equal(clerk.invitations.at(-1).role, 'org:admin');
    assert.deepEqual(clerk.invitations.at(-1).publicMetadata, { roleKey: 'owner' });

    assert.equal((await call('POST', users('/invitations'), { email: 'kasun@shenaly.example', roleKey: 'staff' })).status, 409);
    assert.equal((await call('POST', users('/invitations'), { email: 'x@shenaly.example', roleKey: 'pilot' })).status, 422);
  });

  it('enforces limits.maxUsers, counting pending invitations', async () => {
    // 1 member + 3 pending (provisioning's, staff, co-owner) = 4 of 5 seats.
    assert.equal((await call('POST', users('/invitations'), { email: 'fifth@shenaly.example', roleKey: 'accountant' })).status, 201);
    const full = await call('POST', users('/invitations'), { email: 'sixth@shenaly.example', roleKey: 'staff' });
    assert.equal(full.status, 409);
    assert.match(full.body.error.message, /allows 5 users/);

    const fifth = (await call('GET', users('/invitations'))).body.find((i) => i.email === 'fifth@shenaly.example');
    const revoked = await call('DELETE', users(`/invitations/${fifth.id}`));
    assert.deepEqual(revoked.body, { id: fifth.id, email: 'fifth@shenaly.example', revoked: true });
  });

  it('changes roles and removes members, never leaving the tenant without an Owner', async () => {
    const ownerId = await memberId('user_owner');
    const lastOwner = await call('PATCH', users(`/members/${ownerId}`), { roleKey: 'manager' });
    assert.equal(lastOwner.status, 409);
    assert.match(lastOwner.body.error.message, /at least one Owner/);

    await members().create({ clerkUserId: 'user_kasun', email: 'kasun@shenaly.example', name: 'Kasun Fernando', roleKey: 'staff' });
    const promoted = await call('PATCH', users(`/members/${await memberId('user_kasun')}`), { roleKey: 'owner' });
    assert.equal(promoted.body.roleKey, 'owner');
    assert.deepEqual(clerk.memberRoles.at(-1), { organizationId: tenant.clerkOrgId, userId: 'user_kasun', role: 'org:admin' });

    assert.equal((await call('PATCH', users(`/members/${ownerId}`), { roleKey: 'manager' })).body.roleKey, 'manager');
    const removed = await call('DELETE', users(`/members/${ownerId}`));
    assert.equal(removed.body.status, 'removed');
    assert.deepEqual(clerk.removedMembers.at(-1), { organizationId: tenant.clerkOrgId, userId: 'user_owner' });
    assert.equal((await call('DELETE', users(`/members/${await memberId('user_kasun')}`))).status, 409);
  });

  it('records every change in the platform audit log and the tenant’s own log', async () => {
    const platform = (await call('GET', `/audit?tenantId=${tenant.id}&limit=50`)).body;
    const actions = new Set(platform.map((e) => e.action));
    for (const action of ['member.invited', 'invitation.revoked', 'member.role_changed', 'member.removed']) assert.ok(actions.has(action), action);
    assert.ok(platform.every((e) => e.actor.name === 'Test Admin' || e.action === 'tenant.created'));

    const tenantLog = await db.getTenantDb(tenant.dbName).models.AuditLog.find().lean();
    assert.ok(tenantLog.length >= 4);
    assert.ok(tenantLog.every((e) => e.actor.name === 'Test Admin (platform admin)'));
  });

  it('only changes users of an active tenant, and 404s for unknown tenants and members', async () => {
    const failed = (await call('POST', '/tenants', { name: 'Half Done', slug: 'half-done', template: 'base', adminEmail: 'o@half.fail.test', limits })).body.tenant;
    assert.equal(failed.status, 'provisioning');
    const refused = await call('POST', `/tenants/${failed.id}/invitations`, { email: 'a@half.example', roleKey: 'staff' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /provisioning/);
    assert.deepEqual((await call('GET', `/tenants/${failed.id}/members`)).body, []);

    assert.equal((await call('GET', '/tenants/000000000000000000000000/members')).status, 404);
    assert.equal((await call('PATCH', users('/members/not-an-id'), { roleKey: 'staff' })).status, 404);
  });
});
