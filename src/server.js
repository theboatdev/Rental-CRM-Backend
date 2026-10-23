const dotenv = require('dotenv');

dotenv.config();

const { createApp } = require('./app');
const { createPlatformAuth } = require('./middleware/platformAuth');
const { createTenantAuth } = require('./middleware/tenantAuth');
const { connectPlatformDb, syncPlatformIndexes } = require('./db/platform');
const { createPlatformService } = require('./platform/service');
const { seedDemoTenants } = require('./platform/seed');

const PORT = process.env.PORT || 5000;

const clerkOptions = {
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((origin) => origin.trim()).filter(Boolean)
};

if (!process.env.CLERK_SECRET_KEY) {
  console.warn('[platform] CLERK_SECRET_KEY is not set: /api/platform and /api/v1 respond 503 until it is.');
}

// The server starts without a database: /api/platform still works (in-memory store) and /api/v1 responds 503.
let platformDb = null;
if (process.env.MONGODB_URI) {
  platformDb = connectPlatformDb({ uri: process.env.MONGODB_URI, dbName: process.env.PLATFORM_DB_NAME || 'platform' });
  platformDb
    .asPromise()
    .then(() => syncPlatformIndexes(platformDb))
    .then(() => console.log(`[db] Connected to the platform database "${platformDb.name}"`))
    .catch((error) => console.error(`[db] Platform database unavailable: ${error.message}`));
} else {
  console.warn('[db] MONGODB_URI is not set: /api/v1 responds 503 until it is.');
}

// "shenaly=org_abc,kandy-hill=org_def" links seeded tenants to real Clerk organizations (see src/platform/seed.js).
const clerkOrgIds = Object.fromEntries(
  (process.env.SEED_CLERK_ORG_IDS ?? '')
    .split(',')
    .map((pair) => pair.split('=').map((part) => part.trim()))
    .filter(([slug, orgId]) => slug && orgId)
);
const service = createPlatformService({ seed: (store) => seedDemoTenants(store, { clerkOrgIds }) });

createApp({ platformAuth: createPlatformAuth(clerkOptions), tenantAuth: createTenantAuth(clerkOptions), platformDb, service }).listen(PORT, () => {
  console.log(`[Shenaly Rent a Car] Backend server running on port ${PORT}`);
});
