const { Types } = require('mongoose');
const { createConfigFromTemplate } = require('../../src/platform/config/templates');
const { PROVISIONING_STEPS, tenantDbName } = require('../../src/platform/tenants/rules');
const { PROVISIONER } = require('../../src/platform/provisioning');
const { orgIdFor } = require('./fakeClerk');

/**
 * Demo tenants written straight into the platform DB: Shenaly (active, two
 * config versions), Kandy Hill (provisioning stopped at the invitation) and
 * Coastal Drive (suspended). Their Clerk organization ids are `orgIdFor(slug)`.
 * Their tenant databases aren't initialized; tests call initTenantDb when they need one.
 */
const SEED_ADMIN = { id: 'user_seed_admin', name: 'Platform Admin' };

const DEMO_TENANT_IDS = {
  shenaly: '6712a4f0c2b1e93d8a0f1b2c',
  kandyHill: '6712b9e1d4c3a2f1e0d9c8b7',
  coastalDrive: '6712c0a9b8e7d6c5b4a3f2e1'
};

function jobSteps(at, failAt) {
  let failed = false;
  return PROVISIONING_STEPS.map(({ key, label }) => {
    if (failed) return { key, label, status: 'pending', attempts: 0 };
    if (failAt?.step === key) {
      failed = true;
      return { key, label, status: 'failed', error: failAt.error, attempts: 1, finishedAt: at };
    }
    return { key, label, status: 'done', attempts: 1, finishedAt: at };
  });
}

// Raw inserts keep the given ids and dates exactly.
async function insertDemoTenant({ Tenant, TenantConfig, ProvisioningJob, AuditLog }, { id, versions, failAt, ...tenant }) {
  const _id = new Types.ObjectId(id);
  const latest = versions.at(-1);
  await Tenant.collection.insertOne({
    _id,
    ...tenant,
    clerkOrgId: orgIdFor(tenant.slug),
    dbName: tenantDbName(id),
    activeConfigVersion: versions.length,
    currency: latest.config.locale.currency,
    limits: latest.config.limits,
    createdBy: SEED_ADMIN,
    updatedAt: latest.at
  });
  await TenantConfig.collection.insertMany(
    versions.map((v, index) => ({ tenantId: _id, version: index + 1, config: v.config, note: v.note, createdBy: v.by, createdAt: v.at }))
  );
  const failed = Boolean(failAt);
  await ProvisioningJob.collection.insertOne({
    tenantId: _id,
    status: failed ? 'failed' : 'succeeded',
    steps: jobSteps(tenant.createdAt, failAt),
    startedAt: tenant.createdAt,
    finishedAt: tenant.createdAt,
    heartbeatAt: tenant.createdAt
  });
  await AuditLog.collection.insertMany([
    {
      at: tenant.createdAt,
      actor: SEED_ADMIN,
      action: 'tenant.created',
      tenantId: _id,
      tenantName: tenant.name,
      summary: `Created from the ${tenant.template} template; admin invite to ${tenant.adminEmail}`
    },
    ...versions.slice(1).map((v, index) => ({
      at: v.at,
      actor: v.by,
      action: 'config.published',
      tenantId: _id,
      tenantName: tenant.name,
      summary: `Published v${index + 2}: ${v.note}`
    }))
  ]);
}

async function seedDemoTenants(models) {
  const shenalyLimits = { maxVehicles: 50, maxUsers: 10, storageGb: 5 };
  const shenalyV1 = createConfigFromTemplate('sri-lanka', {
    branding: {
      displayName: 'Shenaly Rent a Car',
      shortName: 'Shenaly',
      tagline: 'Sri Lanka tourist fleet operations',
      primaryColor: '#FF4F00',
      supportEmail: 'admin@shenalyrentacar.com',
      supportPhone: '+94 77 123 4567',
      whatsappNumber: '+94771234567'
    },
    rules: { codePrefixes: { renter: 'SR' } },
    limits: shenalyLimits
  });
  const shenalyV2 = structuredClone(shenalyV1);
  shenalyV2.modules.whatsappDigest.recipients = ['+94770000000'];
  await insertDemoTenant(models, {
    id: DEMO_TENANT_IDS.shenaly,
    name: 'Shenaly Rent a Car',
    slug: 'shenaly',
    status: 'active',
    template: 'sri-lanka',
    adminEmail: 'admin@shenalyrentacar.com',
    adminName: 'Dinuka Silva',
    usage: { vehicles: 6, members: 2, storageGb: 0.4 },
    createdAt: new Date('2026-10-17T05:00:00.000Z'),
    versions: [
      { config: shenalyV1, note: 'Initial config from the sri-lanka template', at: new Date('2026-10-17T05:00:00.000Z'), by: PROVISIONER },
      { config: shenalyV2, note: "Add the owner's number for the Monday digest", at: new Date('2026-10-17T09:30:00.000Z'), by: SEED_ADMIN }
    ]
  });

  const kandyLimits = { maxVehicles: 25, maxUsers: 5, storageGb: 5 };
  await insertDemoTenant(models, {
    id: DEMO_TENANT_IDS.kandyHill,
    name: 'Kandy Hill Rentals (demo)',
    slug: 'kandy-hill',
    status: 'provisioning',
    template: 'sri-lanka',
    adminEmail: 'owner@kandyhill.example',
    adminName: null,
    usage: { vehicles: 0, members: 0, storageGb: 0 },
    createdAt: new Date('2026-10-18T03:10:00.000Z'),
    versions: [
      {
        config: createConfigFromTemplate('sri-lanka', {
          branding: { displayName: 'Kandy Hill Rentals', shortName: 'Kandy Hill', primaryColor: '#15803D' },
          limits: kandyLimits
        }),
        note: 'Initial config from the sri-lanka template',
        at: new Date('2026-10-18T03:10:00.000Z'),
        by: PROVISIONER
      }
    ],
    failAt: { step: 'invite_admin', error: 'Clerk rejected the invitation: address is on the suppression list' }
  });

  const coastalLimits = { maxVehicles: 30, maxUsers: 8, storageGb: 10 };
  await insertDemoTenant(models, {
    id: DEMO_TENANT_IDS.coastalDrive,
    name: 'Coastal Drive Co. (demo)',
    slug: 'coastal-drive',
    status: 'suspended',
    template: 'base',
    adminEmail: 'ops@coastaldrive.example',
    adminName: 'Ama Owusu',
    usage: { vehicles: 12, members: 4, storageGb: 1.2 },
    createdAt: new Date('2026-09-02T08:00:00.000Z'),
    versions: [
      {
        config: createConfigFromTemplate('base', {
          branding: { displayName: 'Coastal Drive Co.', shortName: 'Coastal', primaryColor: '#0E7490' },
          limits: coastalLimits
        }),
        note: 'Initial config from the base template',
        at: new Date('2026-09-02T08:00:00.000Z'),
        by: PROVISIONER
      }
    ]
  });
  await models.AuditLog.collection.insertOne({
    at: new Date('2026-10-10T12:00:00.000Z'),
    actor: SEED_ADMIN,
    action: 'tenant.status_changed',
    tenantId: new Types.ObjectId(DEMO_TENANT_IDS.coastalDrive),
    tenantName: 'Coastal Drive Co. (demo)',
    summary: 'Status changed from active to suspended'
  });
}

module.exports = { seedDemoTenants, DEMO_TENANT_IDS };
