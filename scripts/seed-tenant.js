/**
 * Prepares a tenant database for local development:
 *  1. builds its indexes and system roles (initTenantDb, as provisioning will);
 *  2. adds or updates you as a member, so /api/v1 accepts your Clerk session;
 *  3. with --demo, adds sample vehicles and renters when the tenant has none.
 *
 *   npm run seed -- --user user_2abc --email you@example.com [--name "Your Name"] [--role owner] [--tenant <id>] [--demo]
 *
 * --tenant defaults to Shenaly. Reads MONGODB_URI and PLATFORM_DB_NAME from .env.
 * To call /api/v1, your Clerk user must also belong to the organization linked
 * to the tenant (SEED_CLERK_ORG_IDS) and have it active in the session.
 */
require('dotenv').config();

const { parseArgs } = require('node:util');
const { connectPlatformDb } = require('../src/db/platform');
const { createTenantDbGetter, initTenantDb } = require('../src/db/tenantDb');
const { tenantDbName } = require('../src/platform/tenants/rules');
const { SHENALY_TENANT_ID } = require('../src/platform/seed');

const USAGE =
  'Usage: npm run seed -- --user <clerkUserId> --email <email> [--name <name>] [--role <roleKey>] [--tenant <tenantId>] [--demo]';

const sampleVehicles = [
  {
    plateNumber: 'WP CAH-4821',
    make: 'Suzuki',
    model: 'Alto K10',
    year: 2023,
    fuelType: 'PETROL',
    dailyRate: 6500,
    depositAmount: 25000,
    mileage: 38400,
    thumbnail: 'https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?auto=format&fit=crop&w=600&q=80',
    notes: 'Economical city car. Very high demand.'
  },
  {
    plateNumber: 'WP KX-9312',
    make: 'Toyota',
    model: 'Axio Hybrid',
    year: 2021,
    fuelType: 'HYBRID',
    dailyRate: 14000,
    depositAmount: 35000,
    mileage: 62100,
    thumbnail: 'https://images.unsplash.com/photo-1590362891988-39e15974fa61?auto=format&fit=crop&w=600&q=80',
    notes: 'Premium sedan, ideal for tourist round-trips.'
  },
  {
    plateNumber: 'WP PE-1284',
    make: 'Honda',
    model: 'Vezel RS',
    year: 2022,
    fuelType: 'HYBRID',
    dailyRate: 18500,
    depositAmount: 40000,
    mileage: 49300,
    thumbnail: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=600&q=80',
    notes: 'Compact SUV. Popular for Kandy and Nuwara Eliya tours.'
  },
  {
    plateNumber: 'WP ND-5509',
    make: 'Toyota',
    model: 'HiAce KDH Super GL',
    year: 2020,
    fuelType: 'DIESEL',
    dailyRate: 24000,
    depositAmount: 50000,
    mileage: 91500,
    status: 'MAINTENANCE',
    thumbnail: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=600&q=80',
    notes: 'Tourist passenger van. Scheduled 90,000km injector service.'
  }
];

// Document types are list keys from the Sri Lanka template.
const sampleRenters = [
  {
    profileId: 'SR-0146',
    fullName: 'Nimal Perera',
    phone: '+94 77 123 4567',
    email: 'nimal.p@gmail.com',
    residentType: 'local',
    country: 'Sri Lanka',
    address: 'No. 45, Galle Road, Colombo 03',
    documents: [
      { type: 'NIC', number: '198812304561', verified: true },
      { type: 'DRIVING_LICENSE_LK', number: 'B3920194', verified: true }
    ]
  },
  {
    profileId: 'SR-0147',
    fullName: 'David Miller',
    phone: '+44 7911 123456',
    email: 'david.miller@uktravel.co.uk',
    residentType: 'tourist',
    country: 'United Kingdom',
    address: 'Cinnamon Grand Hotel, Colombo',
    documents: [
      { type: 'PASSPORT', number: 'GB9821034', verified: true },
      { type: 'IDP', number: 'IDP-UK-984', verified: true },
      { type: 'DMT_PERMIT', number: 'DMT-BIA-2026-491', verified: true }
    ]
  },
  {
    profileId: 'SR-0148',
    fullName: 'Kavindi Wickramasinghe',
    phone: '+94 71 889 9234',
    email: 'kavindi.w@dialog.lk',
    residentType: 'local',
    country: 'Sri Lanka',
    address: '12/4 Temple Road, Nugegoda',
    documents: [
      { type: 'NIC', number: '199578102391', verified: true },
      { type: 'DRIVING_LICENSE_LK', number: 'B4829103', verified: true }
    ]
  }
];

async function seedDemoData({ Vehicle, Renter, Counter }) {
  if (await Vehicle.exists({})) {
    console.log('Demo data skipped: the tenant already has vehicles.');
    return;
  }
  await Vehicle.insertMany(sampleVehicles);
  await Renter.insertMany(sampleRenters);
  // The next renter gets SR-0149.
  await Counter.updateOne({ _id: 'renter' }, { $max: { seq: 148 } }, { upsert: true });
  console.log(`Added ${sampleVehicles.length} vehicles and ${sampleRenters.length} renters.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'owner' },
      tenant: { type: 'string', default: SHENALY_TENANT_ID },
      demo: { type: 'boolean', default: false }
    }
  });
  if (!values.user || !values.email) throw new Error(USAGE);
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env');

  const platformDb = connectPlatformDb({ uri: process.env.MONGODB_URI, dbName: process.env.PLATFORM_DB_NAME || 'platform' });
  try {
    await platformDb.asPromise();
    const db = createTenantDbGetter(platformDb)(tenantDbName(values.tenant));
    await initTenantDb(db);
    console.log(`Prepared ${db.name}: indexes and system roles.`);

    const { Member, Role } = db.models;
    if (!(await Role.exists({ key: values.role }))) throw new Error(`There is no "${values.role}" role in ${db.name}`);
    const member = { email: values.email, roleKey: values.role, status: 'active', ...(values.name ? { name: values.name } : {}) };
    await Member.updateOne(
      { clerkUserId: values.user },
      { $set: member, $unset: { removedAt: 1 } },
      { upsert: true, runValidators: true }
    );
    console.log(`${values.email} (${values.user}) is an active ${values.role}.`);

    if (values.demo) await seedDemoData(db.models);
  } finally {
    await platformDb.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
