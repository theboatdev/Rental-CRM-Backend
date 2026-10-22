const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ALL_PERMISSIONS,
  CustomRoleInputSchema,
  SYSTEM_ROLES,
  availablePermissions,
  effectivePermissions,
  isPermission
} = require('../src/platform/rbac/permissions');
const { CONFIG_TEMPLATES } = require('../src/platform/config/templates');

const config = () => structuredClone(CONFIG_TEMPLATES['sri-lanka'].config);
const role = (key) => SYSTEM_ROLES.find((r) => r.key === key);

describe('system roles', () => {
  it('only reference known permissions', () => {
    for (const r of SYSTEM_ROLES) assert.ok(r.permissions.every(isPermission), r.key);
  });

  it('gives the owner everything', () => {
    assert.deepEqual(role('owner').permissions, ALL_PERMISSIONS);
  });

  it('keeps staff away from profit figures and destructive actions', () => {
    for (const p of ['financials:view', 'costs:delete', 'payments:void', 'team:manage']) {
      assert.ok(!role('staff').permissions.includes(p), p);
    }
  });
});

describe('effectivePermissions', () => {
  it('drops permissions of disabled modules', () => {
    const c = config();
    c.modules.fuelLogs.enabled = false;
    c.modules.whatsappDigest.enabled = false;
    const result = effectivePermissions(role('owner').permissions, c);
    assert.ok(!result.includes('fuel:create'));
    assert.ok(!result.includes('whatsapp:view'));
    assert.ok(result.includes('financials:view'));
    assert.deepEqual(availablePermissions(c), result);
  });

  it('ignores unknown and duplicate permission strings', () => {
    assert.deepEqual(effectivePermissions(['vehicles:read', 'vehicles:read', 'legacy:thing'], config()), ['vehicles:read']);
  });
});

describe('CustomRoleInputSchema', () => {
  it('accepts a valid role and dedupes permissions', () => {
    const parsed = CustomRoleInputSchema.parse({
      key: 'front_desk',
      name: 'Front desk',
      permissions: ['renters:create', 'renters:create', 'rentals:checkin']
    });
    assert.deepEqual(parsed.permissions, ['renters:create', 'rentals:checkin']);
  });

  it('rejects unknown permissions and bad keys', () => {
    assert.equal(CustomRoleInputSchema.safeParse({ key: 'Front Desk', name: 'X', permissions: ['nope'] }).success, false);
  });
});
