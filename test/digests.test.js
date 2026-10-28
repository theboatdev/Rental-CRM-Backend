const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { createPlatformService } = require('../src/platform/service');
const { createSecretBox } = require('../src/platform/secrets');
const { createIntegrations } = require('../src/platform/integrations');
const { createDigests, oneLine } = require('../src/platform/digests');
const { parseCron, lastScheduledMinute } = require('../src/platform/cron');
const { unauthenticated } = require('../src/platform/errors');
const { startTestDb } = require('./helpers/db');
const { createFakeClerk, orgIdFor } = require('./helpers/fakeClerk');

const ADMIN = { id: 'user_super', name: 'Test Admin' };
const KEY = crypto.randomBytes(32).toString('base64');
const RECIPIENTS = ['+94771234567', '+94779876543'];
const TOKEN = 'EAAG-test-access-token-0123456789-wxyz';
// Monday 26 October 2026, 08:00 in Colombo (UTC+5:30).
const MONDAY_8AM = new Date('2026-10-26T02:30:00Z');
const minutesAfter = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

/** Stands in for the WhatsApp gateway: records messages, and fails for numbers in `failFor`. */
function createFakeWhatsApp() {
  let next = 1;
  return {
    sent: [],
    failFor: new Set(),
    async send(message) {
      if (this.failFor.has(message.to)) throw new Error('Recipient phone number not in allowed list (code 131030)');
      this.sent.push(message);
      return { messageId: `wamid.${next++}` };
    }
  };
}

describe('cron expressions', () => {
  it('finds the scheduled minute in the tenant time zone, up to the catch-up window', () => {
    assert.deepEqual(lastScheduledMinute('0 8 * * 1', 'Asia/Colombo', minutesAfter(MONDAY_8AM, 15)), MONDAY_8AM);
    assert.deepEqual(lastScheduledMinute('0 8 * * 1', 'Asia/Colombo', MONDAY_8AM), MONDAY_8AM);
    assert.equal(lastScheduledMinute('0 8 * * 1', 'Asia/Colombo', minutesAfter(MONDAY_8AM, 61)), null);
    assert.equal(lastScheduledMinute('0 8 * * 1', 'Asia/Colombo', minutesAfter(MONDAY_8AM, -1)), null);
    // London is on summer time (UTC+1) until Sunday 25 October 2026, then on UTC.
    assert.deepEqual(lastScheduledMinute('0 8 * * 1', 'Europe/London', new Date('2026-10-19T07:05:00Z')), new Date('2026-10-19T07:00:00Z'));
    assert.deepEqual(lastScheduledMinute('0 8 * * 1', 'Europe/London', new Date('2026-10-26T08:05:00Z')), new Date('2026-10-26T08:00:00Z'));
  });

  it('reads steps, ranges, lists and Sunday as 0 or 7', () => {
    const cron = parseCron('*/15 9-17 * * 1-5');
    assert.deepEqual([...cron.minute], [0, 15, 30, 45]);
    assert.equal(cron.hour.size, 9);
    assert.deepEqual([...parseCron('0 8 * * 7').dayOfWeek], [0]);
    assert.deepEqual([...parseCron('5,35 * * * *').minute], [5, 35]);
  });

  it('fires on either restricted day field', () => {
    // Sunday 1 November 2026 is the 1st; Monday 2 November is a Monday.
    assert.ok(lastScheduledMinute('0 8 1 * 1', 'UTC', new Date('2026-11-01T08:00:00Z')));
    assert.ok(lastScheduledMinute('0 8 1 * 1', 'UTC', new Date('2026-11-02T08:00:00Z')));
    assert.equal(lastScheduledMinute('0 8 1 * 1', 'UTC', new Date('2026-11-03T08:00:00Z')), null);
  });

  it('refuses what it can’t read', () => {
    assert.throws(() => parseCron('61 * * * *'), /minute field/);
    assert.throws(() => parseCron('0 8 * *'), /5-field/);
  });
});

describe('the secret box', () => {
  const box = createSecretBox(KEY);
  const binding = { tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'whatsapp.connection' };

  it('decrypts only with the same key and binding', () => {
    const sealed = box.encrypt('a secret', binding);
    assert.ok(!sealed.ciphertext.includes('secret'));
    assert.equal(box.decrypt(sealed, binding), 'a secret');
    assert.throws(() => box.decrypt(sealed, { ...binding, tenantId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }));
    assert.throws(() => createSecretBox(crypto.randomBytes(32).toString('base64')).decrypt(sealed, binding));
  });

  it('needs a 32-byte key, and says so without one', () => {
    assert.throws(() => createSecretBox(crypto.randomBytes(16).toString('base64')), /32 bytes/);
    assert.throws(() => createSecretBox().encrypt('x', binding), (error) => error.code === 'secrets_not_configured');
  });
});

describe('template text', () => {
  it('puts the digest on one line, without its title and sign-off', () => {
    const message = '*SHENALY — WEEKLY FLEET DIGEST*\n19 Oct – 25 Oct 2026\n\n*FLEET*\n• 6 vehicles: 4 on the road\n• Utilization: 67%\n\n_Sent by Shenaly operations_';
    assert.equal(oneLine(message), '19 Oct – 25 Oct 2026 · *FLEET* · 6 vehicles: 4 on the road · Utilization: 67%');
    const long = oneLine(`title\n${'x'.repeat(2000)}\nend`);
    assert.equal(long.length, 900);
    assert.ok(long.endsWith('…'));
  });
});

describe('WhatsApp digests', () => {
  let db;
  let service;
  let whatsapp;
  let tenant;
  let server;
  let baseUrl;
  const ORG = orgIdFor('digest-cars');

  function stubTenantAuth(req, res, next) {
    const userId = req.get('x-test-user');
    if (!userId) return next(unauthenticated('Sign in required'));
    req.identity = { userId, orgId: ORG };
    next();
  }
  const stubPlatformAuth = (req, res, next) => {
    req.actor = ADMIN;
    next();
  };

  const call = async (method, path, body, user) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const platform = (method, path, body) => call(method, `/api/platform/tenants/${tenant.id}${path}`, body);
  const tenantApi = (user) => (method, path, body) => call(method, `/api/v1${path}`, body, user);

  const digestsAt = (at) =>
    createDigests({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, whatsapp, integrations: createIntegrations({ platformDb: db.platformDb, secretBox: createSecretBox(KEY) }), now: () => at });

  async function publish(change) {
    const active = await service.getActiveConfig(tenant.id);
    const config = structuredClone(active.config);
    change(config);
    await service.publishConfig(tenant.id, { config, note: 'Test change', baseVersion: active.version }, ADMIN);
  }

  before(async () => {
    db = await startTestDb();
    whatsapp = createFakeWhatsApp();
    const clerk = createFakeClerk();
    service = createPlatformService({ platformDb: db.platformDb, getTenantDb: db.getTenantDb, clerk });
    ({ tenant } = await service.createTenant(
      { name: 'Digest Cars', slug: 'digest-cars', template: 'sri-lanka', adminEmail: 'a@digest.example', limits: { maxVehicles: 10, maxUsers: 10, storageGb: 1 } },
      ADMIN
    ));
    await publish((config) => {
      config.modules.whatsappDigest.recipients = RECIPIENTS;
    });
    const { Member, Vehicle } = db.getTenantDb(tenant.dbName).models;
    for (const [clerkUserId, roleKey] of [['user_owner', 'owner'], ['user_accountant', 'accountant']]) {
      await Member.create({ clerkUserId, email: `${clerkUserId}@digest.example`, name: clerkUserId, roleKey });
    }
    await Vehicle.create({ plateNumber: 'WP DIG-0001', make: 'Toyota', model: 'Prius', dailyRate: 12000, depositAmount: 20000 });

    const app = createApp({ platformAuth: stubPlatformAuth, tenantAuth: stubTenantAuth, platformDb: db.platformDb, clerk, secretBox: createSecretBox(KEY), whatsapp });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.stop();
  });

  it('records a failed run when the tenant has no WhatsApp connection', async () => {
    const [run] = await digestsAt(minutesAfter(MONDAY_8AM, -7 * 24 * 60)).runDue();
    assert.equal(run.status, 'failed');
    assert.match(run.error, /isn't connected/);
    assert.equal(whatsapp.sent.length, 0);
  });

  it('stores the connection encrypted and never returns the token', async () => {
    assert.equal((await platform('GET', '/integrations/whatsapp')).body.connected, false);
    const bad = await platform('PUT', '/integrations/whatsapp', { phoneNumberId: '+94 77 123', accessToken: 'short' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.error.issues.map((i) => i.path).sort(), ['accessToken', 'phoneNumberId']);
    assert.equal((await platform('PUT', '/integrations/whatsapp', { phoneNumberId: '1234567890' })).status, 422);

    const { status, body } = await platform('PUT', '/integrations/whatsapp', { phoneNumberId: '1234567890', accessToken: TOKEN });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.connected, true);
    assert.equal(body.mode, 'text');
    assert.equal(body.tokenEnding, 'wxyz');
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    const stored = await db.platformDb.models.TenantSecret.findOne({ tenantId: tenant.id }).lean();
    assert.ok(!JSON.stringify(stored).includes(TOKEN) && !JSON.stringify(stored).includes('1234567890'));
    const audit = await service.listAudit({ tenantId: tenant.id });
    assert.ok(audit.some((entry) => entry.action === 'integration.whatsapp_updated'));
  });

  it('sends the digest on its schedule, once per slot, with the money lines', async () => {
    const at = minutesAfter(MONDAY_8AM, 3);
    const runs = await digestsAt(at).runDue();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'sent');
    assert.equal(runs[0].slot, MONDAY_8AM.toISOString());
    assert.equal(runs[0].includesFinancials, true);
    assert.deepEqual(whatsapp.sent.map((m) => m.to), RECIPIENTS);
    assert.equal(whatsapp.sent[0].phoneNumberId, '1234567890');
    assert.equal(whatsapp.sent[0].accessToken, TOKEN);
    assert.match(whatsapp.sent[0].text, /LAST 7 DAYS/);

    assert.deepEqual(await digestsAt(minutesAfter(at, 1)).runDue(), []);
    assert.equal(whatsapp.sent.length, 2);
  });

  it('lets only one backend instance claim a slot', async () => {
    const nextMonday = minutesAfter(MONDAY_8AM, 7 * 24 * 60);
    whatsapp.sent.length = 0;
    const results = await Promise.all([digestsAt(nextMonday).runDue(), digestsAt(nextMonday).runDue(), digestsAt(nextMonday).runDue()]);
    assert.equal(results.flat().length, 1);
    assert.equal(whatsapp.sent.length, RECIPIENTS.length);
  });

  it('sends the approved template, with the digest on one line, and reports a recipient that failed', async () => {
    await platform('PUT', '/integrations/whatsapp', { phoneNumberId: '1234567890', templateName: 'weekly_fleet_digest', templateLanguage: 'en_US' });
    whatsapp.sent.length = 0;
    whatsapp.failFor.add(RECIPIENTS[1]);
    try {
      const [run] = await digestsAt(minutesAfter(MONDAY_8AM, 14 * 24 * 60)).runDue();
      assert.equal(run.status, 'partial');
      assert.equal(run.mode, 'template');
      assert.deepEqual(run.results.map((r) => r.ok), [true, false]);
      assert.match(run.results[1].error, /131030/);
      const [message] = whatsapp.sent;
      assert.equal(message.template.name, 'weekly_fleet_digest');
      assert.equal(message.template.language, 'en_US');
      assert.equal(message.template.parameters[0], 'Digest Cars');
      assert.doesNotMatch(message.template.parameters[1], /\n/);
      assert.equal(message.accessToken, TOKEN); // kept when the token is left out
    } finally {
      whatsapp.failFor.clear();
    }
  });

  it('shows delivery in the tenant app and sends by hand with whatsapp:manage', async () => {
    const owner = tenantApi('user_owner');
    const digest = await owner('GET', '/whatsapp/digest');
    assert.equal(digest.status, 200);
    assert.equal(digest.body.delivery.connected, true);
    assert.equal(digest.body.delivery.mode, 'template');
    assert.equal(digest.body.delivery.runs[0].status, 'partial');

    whatsapp.sent.length = 0;
    const sent = await owner('POST', '/whatsapp/digest/send');
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.trigger, 'manual');
    assert.equal(sent.body.status, 'sent');
    assert.equal(sent.body.by.id, 'user_owner');
    assert.equal(whatsapp.sent.length, RECIPIENTS.length);

    const accountant = tenantApi('user_accountant');
    assert.equal((await accountant('GET', '/whatsapp/digest')).status, 200);
    assert.equal((await accountant('POST', '/whatsapp/digest/send')).status, 403);
  });

  it('disconnects, and the digest stops going out', async () => {
    const removed = await platform('DELETE', '/integrations/whatsapp');
    assert.equal(removed.status, 200);
    assert.equal(removed.body.connected, false);
    assert.equal((await tenantApi('user_owner')('GET', '/whatsapp/digest')).body.delivery.connected, false);
  });

  it('responds 503 for connections without TENANT_SECRETS_KEY', async () => {
    const app = createApp({ platformAuth: stubPlatformAuth, platformDb: db.platformDb, clerk: createFakeClerk() });
    const other = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => other.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${other.address().port}/api/platform/tenants/${tenant.id}/integrations/whatsapp`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumberId: '1234567890', accessToken: TOKEN })
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'secrets_not_configured');
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
