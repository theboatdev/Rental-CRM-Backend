const dotenv = require('dotenv');

dotenv.config();

const { createApp } = require('./app');
const { createPlatformAuth } = require('./middleware/platformAuth');
const { createTenantAuth } = require('./middleware/tenantAuth');
const { connectPlatformDb, waitForConnection, syncPlatformIndexes } = require('./db/platform');
const { createClerkGateway } = require('./platform/clerk');
const { createStorageGateway } = require('./platform/storage');
const { createSecretBox } = require('./platform/secrets');
const { createWhatsAppGateway } = require('./platform/whatsapp');

const PORT = process.env.PORT || 5000;

/** TRUST_PROXY: `true`, a number of proxy hops, or Express's names (e.g. `loopback`). Unset: client IPs are taken as they arrive. */
function trustProxySetting(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

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
if (!process.env.CLOUDINARY_URL) {
  console.warn('[storage] CLOUDINARY_URL is not set: uploads respond 503 and records are saved without files.');
}
if (!process.env.TENANT_SECRETS_KEY) {
  console.warn('[secrets] TENANT_SECRETS_KEY is not set: WhatsApp connections can\'t be stored, so digests are not sent.');
}

// The server starts without a database; the routes that need it respond 503 until it's reachable.
let platformDb = null;
if (process.env.MONGODB_URI) {
  const database = { uri: process.env.MONGODB_URI, dbName: process.env.PLATFORM_DB_NAME || 'platform' };
  platformDb = connectPlatformDb(database);
  waitForConnection(platformDb, {
    ...database,
    onRetry: (error) => console.error(`[db] Platform database unavailable: ${error.message.split('\n')[0]} Retrying in 15 s.`)
  })
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
  storage: createStorageGateway({ url: process.env.CLOUDINARY_URL }),
  secretBox: createSecretBox(process.env.TENANT_SECRETS_KEY),
  whatsapp: createWhatsAppGateway({ graphVersion: process.env.WHATSAPP_GRAPH_VERSION || undefined }),
  scheduleDigests: Boolean(platformDb),
  webhookSigningSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  trustProxy: trustProxySetting(process.env.TRUST_PROXY)
});

app.listen(PORT, () => {
  console.log(`[Shenaly Rent a Car] Backend server running on port ${PORT}`);
});
