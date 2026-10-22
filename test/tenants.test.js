const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CreateTenantInputSchema, TenantSlugSchema, canTransitionTenant, tenantDbName } = require('../src/platform/tenants/rules');
const { isSuperAdmin } = require('../src/platform/platformRole');

describe('tenant slugs', () => {
  for (const slug of ['shenaly', 'shenaly-rent-a-car', 'abc', 'fleet-2026']) {
    it(`accepts ${slug}`, () => assert.equal(TenantSlugSchema.safeParse(slug).success, true));
  }
  for (const slug of ['ab', '-shenaly', 'shenaly-', 'Shenaly', 'shen--aly', 'admin', 'book', 'a'.repeat(33)]) {
    it(`rejects ${slug}`, () => assert.equal(TenantSlugSchema.safeParse(slug).success, false));
  }
});

describe('tenantDbName', () => {
  it('prefixes the tenant id', () => {
    assert.equal(tenantDbName('6712a4f0c2b1e93d8a0f1b2c'), 'tenant_6712a4f0c2b1e93d8a0f1b2c');
  });

  it('refuses ids that could escape the naming scheme', () => {
    assert.throws(() => tenantDbName('../platform'));
  });
});

describe('CreateTenantInputSchema', () => {
  it('validates the create-tenant form', () => {
    const result = CreateTenantInputSchema.safeParse({
      name: 'Shenaly Rent a Car',
      slug: 'shenaly',
      template: 'sri-lanka',
      adminEmail: 'owner@shenalyrentacar.com',
      limits: { maxVehicles: 50, maxUsers: 10, storageGb: 5 }
    });
    assert.equal(result.success, true);
  });
});

describe('canTransitionTenant', () => {
  it('allows suspend/reactivate and blocks skipping provisioning', () => {
    assert.equal(canTransitionTenant('active', 'suspended'), true);
    assert.equal(canTransitionTenant('suspended', 'active'), true);
    assert.equal(canTransitionTenant('provisioning', 'active'), false);
    assert.equal(canTransitionTenant('archived', 'active'), false);
  });
});

describe('isSuperAdmin', () => {
  it('reads platformRole from session claim metadata', () => {
    assert.equal(isSuperAdmin({ metadata: { platformRole: 'super_admin' } }), true);
    assert.equal(isSuperAdmin({ metadata: { platformRole: 'tenant_admin' } }), false);
    assert.equal(isSuperAdmin({ metadata: {} }), false);
    assert.equal(isSuperAdmin(null), false);
  });
});
