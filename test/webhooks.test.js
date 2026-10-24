const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { createPlatformService } = require('../src/platform/service');
const { forbidden, unauthenticated } = require('../src/platform/errors');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

const SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;
const ADMIN = { id: 'user_test_admin', name: 'Test Admin' };
const ORG = orgIdFor('galle-fort');

function stubTenantAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return next(unauthenticated('Sign in required'));
  req.identity = { userId, orgId: req.get('x-test-org') };
  if (!req.identity.orgId) return next(forbidden('Select an organization first'));
  next();
}
const denyPlatform = (req, res, next) => next(forbidden('Not under test'));

/** Signs a body the way Clerk (Svix) does: HMAC-SHA256 over "id.timestamp.body" with the decoded secret. */
function signedHeaders(body, secret = SECRET) {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

let clock = Date.now();
/** A Clerk event; each one is 1 s newer than the last unless `timestamp` is given. */
const event = (type, data, timestamp = (clock += 1000)) => ({ type, object: 'event', timestamp, data });

const membership = ({ userId, org = ORG, email = `${userId}@example.com`, first = 'Test', last = 'User', role = 'org:member', roleKey }) => ({
  id: `orgmem_${userId}`,
  object: 'organization_membership',
  role,
  public_metadata: roleKey ? { roleKey } : {},
  organization: { id: org },
  public_user_data: { user_id: userId, identifier: email, first_name: first, last_name: last }
});

let db;
let clerk;
let tenant;
const servers = [];
let baseUrl;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function send(evt, { url = baseUrl, secret = SECRET, tamper = false } = {}) {
  const body = JSON.stringify(evt);
  const headers = signedHeaders(body, secret);
  const res = await fetch(`${url}/webhooks/clerk`, { method: 'POST', headers, body: tamper ? body.replace('org:', 'org;') : body });
  return { status: res.status, body: await res.json() };
}

const members = () => db.getTenantDb(tenant.dbName).models.Member;
const member = (clerkUserId) => members().findOne({ clerkUserId }).lean();
const usage = async () => (await db.platformDb.models.Tenant.findById(tenant.id).lean()).usage.members;

before(async () => {
  db = await startTestDb();
  clerk = createFakeClerk();
  const service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
  ({ tenant } = await service.createTenant(
    { name: 'Galle Fort Drives', slug: 'galle-fort', template: 'base', adminEmail: 'owner@gallefort.example', limits: { maxVehicles: 10, maxUsers: 5, storageGb: 2 } },
    ADMIN
  ));
  baseUrl = await listen(
    createApp({ platformAuth: denyPlatform, tenantAuth: stubTenantAuth, platformDb: db.platformDb, clerk, webhookSigningSecret: SECRET })
  );
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await db?.stop();
});

describe('Clerk webhooks', () => {
  it('rejects unsigned, tampered or wrongly signed events', async () => {
    const evt = event('organizationMembership.created', membership({ userId: 'user_x' }));
    const unsigned = await fetch(`${baseUrl}/webhooks/clerk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(evt) });
    assert.equal(unsigned.status, 400);
    assert.equal((await send(evt, { tamper: true })).body.error.code, 'invalid_signature');
    assert.equal((await send(evt, { secret: `whsec_${crypto.randomBytes(24).toString('base64')}` })).status, 400);
    assert.equal(await member('user_x'), null);
  });

  it('responds 503 without a signing secret, so Clerk retries later', async () => {
    const url = await listen(createApp({ platformAuth: denyPlatform, platformDb: db.platformDb, clerk }));
    const { status, body } = await send(event('organizationMembership.created', membership({ userId: 'user_x' })), { url });
    assert.equal(status, 503);
    assert.equal(body.error.code, 'webhooks_not_configured');
  });

  it('makes the invited admin an Owner who can call the tenant API', async () => {
    const accepted = event('organizationMembership.created', membership({ userId: 'user_owner', first: 'Ava', last: 'Owner', role: 'org:admin', roleKey: 'owner' }));
    const { status, body } = await send(accepted);
    assert.equal(status, 200);
    assert.equal(body.applied, true);

    const owner = await member('user_owner');
    assert.equal(owner.roleKey, 'owner');
    assert.equal(owner.name, 'Ava Owner');
    assert.equal(owner.status, 'active');
    assert.equal(await usage(), 1);

    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-test-user': 'user_owner', 'x-test-org': ORG } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role.key, 'owner');
  });

  it('gives members without a usable roleKey staff, or owner for org:admin', async () => {
    await send(event('organizationMembership.created', membership({ userId: 'user_plain' })));
    await send(event('organizationMembership.created', membership({ userId: 'user_bogus', roleKey: 'no_such_role' })));
    await send(event('organizationMembership.created', membership({ userId: 'user_admin', role: 'org:admin' })));
    assert.equal((await member('user_plain')).roleKey, 'staff');
    assert.equal((await member('user_bogus')).roleKey, 'staff');
    assert.equal((await member('user_admin')).roleKey, 'owner');
  });

  it("keeps the tenant's role assignment when Clerk reports an update", async () => {
    await members().updateOne({ clerkUserId: 'user_plain' }, { $set: { roleKey: 'manager' } });
    await send(event('organizationMembership.updated', membership({ userId: 'user_plain', first: 'Renamed', role: 'org:admin', roleKey: 'owner' })));
    const updated = await member('user_plain');
    assert.equal(updated.roleKey, 'manager');
    assert.equal(updated.name, 'Renamed User');
  });

  it('settles repeated and out-of-order deliveries on the newest event', async () => {
    const created = event('organizationMembership.created', membership({ userId: 'user_leaver' }));
    const updated = event('organizationMembership.updated', membership({ userId: 'user_leaver', first: 'Stale' }));
    const deleted = event('organizationMembership.deleted', membership({ userId: 'user_leaver' }));
    const before = await usage();

    await send(created);
    assert.equal(await usage(), before + 1);
    await send(deleted);
    assert.equal((await send(updated)).body.applied, false); // older than the deletion
    assert.equal((await send(created)).body.applied, false); // redelivered
    assert.equal((await send(deleted)).body.applied, true); // same event again: harmless

    const leaver = await member('user_leaver');
    assert.equal(leaver.status, 'removed');
    assert.ok(leaver.removedAt);
    assert.equal(await usage(), before);

    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-test-user': 'user_leaver', 'x-test-org': ORG } });
    assert.equal(me.status, 403);
  });

  it("doesn't let a late 'created' bring back a member removed before we saw them", async () => {
    const created = event('organizationMembership.created', membership({ userId: 'user_ghost' }));
    const deleted = event('organizationMembership.deleted', membership({ userId: 'user_ghost' }));
    await send(deleted);
    await send(created);
    assert.equal((await member('user_ghost')).status, 'removed');
  });

  it('re-activates a removed member who is invited back, with the new role', async () => {
    await send(event('organizationMembership.created', membership({ userId: 'user_leaver', roleKey: 'accountant' })));
    const back = await member('user_leaver');
    assert.equal(back.status, 'active');
    assert.equal(back.roleKey, 'accountant');
    assert.equal(back.removedAt, undefined);
  });

  it("copies a user's new name and primary email to every tenant they belong to", async () => {
    clerk.userOrganizations.set('user_owner', [ORG, 'org_not_a_tenant']);
    const { body } = await send(
      event('user.updated', {
        id: 'user_owner',
        first_name: 'Ava',
        last_name: 'Silva',
        primary_email_address_id: 'idn_2',
        email_addresses: [
          { id: 'idn_1', email_address: 'old@example.com' },
          { id: 'idn_2', email_address: 'ava@gallefort.example' }
        ]
      })
    );
    assert.equal(body.applied, true);
    const owner = await member('user_owner');
    assert.equal(owner.name, 'Ava Silva');
    assert.equal(owner.email, 'ava@gallefort.example');
    assert.equal(owner.roleKey, 'owner');
  });

  it('ignores other organizations and event types', async () => {
    assert.equal((await send(event('organizationMembership.created', membership({ userId: 'user_y', org: 'org_unknown' })))).body.applied, false);
    assert.equal((await send(event('organizationInvitation.accepted', { id: 'orginv_1', organization_id: ORG }))).body.applied, false);
    assert.equal((await send(event('session.created', { id: 'sess_1' }))).body.applied, false);
    assert.equal(await member('user_y'), null);
  });

  it("creates a member from their Clerk membership when they arrive before the webhook", async () => {
    clerk.addMembership({ organizationId: ORG, userId: 'user_early', email: 'early@gallefort.example', firstName: 'Eli', lastName: 'Early', roleKey: 'manager' });
    const before = await usage();
    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-test-user': 'user_early', 'x-test-org': ORG } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role.key, 'manager');
    const early = await member('user_early');
    assert.equal(early.name, 'Eli Early');
    assert.equal(early.status, 'active');
    assert.equal(await usage(), before + 1);
  });

  it("refuses someone Clerk doesn't know, and doesn't ask Clerk again straight away", async () => {
    const headers = { 'x-test-user': 'user_stranger', 'x-test-org': ORG };
    const callsBefore = clerk.calls.getMembership;
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers })).status, 403);
    assert.equal(clerk.calls.getMembership, callsBefore + 1);
    assert.equal(await member('user_stranger'), null);
  });

  it("doesn't bring back a removed member from a membership older than the removal", async () => {
    const joined = event('organizationMembership.created', membership({ userId: 'user_gone' }));
    const stale = clock + 500; // between joining and leaving
    const left = event('organizationMembership.deleted', membership({ userId: 'user_gone' }));
    await send(joined);
    await send(left);
    clerk.addMembership({ organizationId: ORG, userId: 'user_gone', email: 'user_gone@example.com', updatedAt: stale });
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-test-user': 'user_gone', 'x-test-org': ORG } })).status, 403);
    assert.equal((await member('user_gone')).status, 'removed');
  });

  it('suspends the tenant when its Clerk organization is deleted', async () => {
    const { body } = await send(event('organization.deleted', { id: ORG, object: 'organization', deleted: true }));
    assert.equal(body.applied, true);
    const { Tenant, AuditLog } = db.platformDb.models;
    assert.equal((await Tenant.findById(tenant.id).lean()).status, 'suspended');
    const [entry] = await AuditLog.find({ tenantId: tenant.id }).sort({ at: -1 }).limit(1).lean();
    assert.equal(entry.action, 'tenant.status_changed');
    assert.equal(entry.actor.name, 'Clerk webhook');
  });
});
