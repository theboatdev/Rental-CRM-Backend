const dotenv = require('dotenv');

dotenv.config();

const { createApp } = require('./app');
const { createPlatformAuth } = require('./middleware/platformAuth');
const { createTenantAuth } = require('./middleware/tenantAuth');
const { connectPlatformDb, syncPlatformIndexes } = require('./db/platform');
const { createClerkGateway } = require('./platform/clerk');

const PORT = process.env.PORT || 5000;

const clerkOptions = {
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((origin) => origin.trim()).filter(Boolean)
};

if (!process.env.CLERK_SECRET_KEY) {
  console.warn('[platform] CLERK_SECRET_KEY is not set: /api/platform and /api/v1 respond 503 until it is.');
}
if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
  console.warn('[webhooks] CLERK_WEBHOOK_SIGNING_SECRET is not set: /webhooks/clerk responds 503 and members are not synced from Clerk.');
}

// The server starts without a database; the routes that need it respond 503 until it's reachable.
let platformDb = null;
if (process.env.MONGODB_URI) {
  platformDb = connectPlatformDb({ uri: process.env.MONGODB_URI, dbName: process.env.PLATFORM_DB_NAME || 'platform' });
  platformDb
    .asPromise()
    .then(() => syncPlatformIndexes(platformDb))
    .then(() => console.log(`[db] Connected to the platform database "${platformDb.name}"`))
    .catch((error) => console.error(`[db] Platform database unavailable: ${error.message}`));
} else {
  console.warn('[db] MONGODB_URI is not set: /api/platform and /api/v1 respond 503 until it is.');
}

const app = createApp({
  platformAuth: createPlatformAuth(clerkOptions),
  tenantAuth: createTenantAuth(clerkOptions),
  platformDb,
  clerk: createClerkGateway({
    secretKey: process.env.CLERK_SECRET_KEY,
    invitationRedirectUrl: process.env.CLERK_INVITATION_REDIRECT_URL
  }),
  webhookSigningSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET
});

app.listen(PORT, () => {
  console.log(`[Shenaly Rent a Car] Backend server running on port ${PORT}`);
});
