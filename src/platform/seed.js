/**
 * Demo tenants for the in-memory platform store: Shenaly (tenant #1, migrated
 * from the single-tenant demo) plus two tenants covering other lifecycle states.
 */
const SEED_ADMIN = { id: 'user_seed_admin', name: 'Platform Admin' };

function seedDemoTenants({ insertTenant, record, createConfigFromTemplate, PROVISIONER }) {
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
  insertTenant(
    {
      id: '6712a4f0c2b1e93d8a0f1b2c',
      name: 'Shenaly Rent a Car',
      slug: 'shenaly',
      status: 'active',
      template: 'sri-lanka',
      adminEmail: 'admin@shenalyrentacar.com',
      adminName: 'Dinuka Silva',
      limits: shenalyLimits,
      usage: { vehicles: 6, members: 2, storageGb: 0.4 },
      createdAt: '2026-10-17T05:00:00.000Z'
    },
    [
      { config: shenalyV1, note: 'Initial config from the Sri Lanka template', at: '2026-10-17T05:00:00.000Z', by: PROVISIONER },
      { config: shenalyV2, note: "Add the owner's number for the Monday digest", at: '2026-10-17T09:30:00.000Z', by: SEED_ADMIN }
    ],
    { createdBy: SEED_ADMIN }
  );

  const kandyLimits = { maxVehicles: 25, maxUsers: 5, storageGb: 5 };
  insertTenant(
    {
      id: '6712b9e1d4c3a2f1e0d9c8b7',
      name: 'Kandy Hill Rentals (demo)',
      slug: 'kandy-hill',
      status: 'provisioning',
      template: 'sri-lanka',
      adminEmail: 'owner@kandyhill.fail.test',
      adminName: null,
      limits: kandyLimits,
      usage: { vehicles: 0, members: 0, storageGb: 0 },
      createdAt: '2026-10-18T03:10:00.000Z'
    },
    [
      {
        config: createConfigFromTemplate('sri-lanka', {
          branding: { displayName: 'Kandy Hill Rentals', shortName: 'Kandy Hill', primaryColor: '#15803D' },
          limits: kandyLimits
        }),
        note: 'Initial config from the Sri Lanka template',
        at: '2026-10-18T03:10:00.000Z',
        by: PROVISIONER
      }
    ],
    {
      createdBy: SEED_ADMIN,
      failAt: { step: 'invite_admin', error: 'Clerk rejected the invitation: address is on the suppression list (mock)' }
    }
  );

  const coastalLimits = { maxVehicles: 30, maxUsers: 8, storageGb: 10 };
  insertTenant(
    {
      id: '6712c0a9b8e7d6c5b4a3f2e1',
      name: 'Coastal Drive Co. (demo)',
      slug: 'coastal-drive',
      status: 'suspended',
      template: 'base',
      adminEmail: 'ops@coastaldrive.example',
      adminName: 'Ama Owusu',
      limits: coastalLimits,
      usage: { vehicles: 12, members: 4, storageGb: 1.2 },
      createdAt: '2026-09-02T08:00:00.000Z'
    },
    [
      {
        config: createConfigFromTemplate('base', {
          branding: { displayName: 'Coastal Drive Co.', shortName: 'Coastal', primaryColor: '#0E7490' },
          limits: coastalLimits
        }),
        note: 'Initial config from the Base template',
        at: '2026-09-02T08:00:00.000Z',
        by: PROVISIONER
      }
    ],
    { createdBy: SEED_ADMIN }
  );
  record({
    at: '2026-10-10T12:00:00.000Z',
    actor: SEED_ADMIN,
    action: 'tenant.status_changed',
    tenantId: '6712c0a9b8e7d6c5b4a3f2e1',
    tenantName: 'Coastal Drive Co. (demo)',
    summary: 'Status changed from active to suspended'
  });
}

module.exports = { seedDemoTenants };
