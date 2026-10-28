const express = require('express');
const cors = require('cors');
const { createPlatformRouter } = require('./routes/platform');
const { createTenantRouter } = require('./routes/tenant');
const { createWebhookRouter } = require('./routes/webhooks');
const { createPublicRouter } = require('./routes/public');
const { createPlatformService } = require('./platform/service');
const { createMemberSync } = require('./platform/members');
const { createTenantUsers } = require('./platform/tenantUsers');
const { createTenantDbGetter } = require('./db/tenantDb');
const { errorHandler } = require('./middleware/errorHandler');
const { createTenantAuth } = require('./middleware/tenantAuth');
const { isConnected } = require('./db/platform');
const { createStorageGateway } = require('./platform/storage');
const { createSecretBox } = require('./platform/secrets');
const { createWhatsAppGateway } = require('./platform/whatsapp');
const { createIntegrations } = require('./platform/integrations');
const { createDigests } = require('./platform/digests');

/**
 * Builds the Express app.
 * - `platformAuth` guards /api/platform and `tenantAuth` starts the /api/v1
 *   chain (Clerk in server.js, stubs in tests).
 * - `platformDb` is the platform connection; tenant DBs are reached through
 *   it. Without it, everything but /api/health and the platform rules responds 503.
 * - `clerk` is the Clerk gateway used by provisioning and the webhooks (a fake in tests).
 * - `storage` is the Cloudinary gateway for files (a fake in tests); without
 *   one, uploads respond 503.
 * - `secretBox` encrypts integration credentials (secrets.js); `whatsapp`
 *   sends digests (a fake in tests). With `scheduleDigests`, digests go out
 *   on each tenant's schedule.
 * - `webhookSigningSecret` verifies /webhooks/clerk.
 * - `trustProxy` is Express's `trust proxy` setting, so the public routes'
 *   rate limits see client IPs behind a load balancer.
 */
function createApp({
  platformAuth,
  tenantAuth = createTenantAuth({}),
  platformDb,
  clerk,
  storage = createStorageGateway({}),
  secretBox = createSecretBox(),
  whatsapp = createWhatsAppGateway(),
  scheduleDigests = false,
  webhookSigningSecret,
  trustProxy = false
}) {
  const getTenantDb = platformDb && createTenantDbGetter(platformDb);
  const service = platformDb && createPlatformService({ platformDb, getTenantDb, clerk, storage });
  const memberSync = platformDb && createMemberSync({ platformDb, getTenantDb, clerk });
  const tenantUsers = platformDb && createTenantUsers({ platformDb, getTenantDb, clerk });
  const integrations = platformDb && createIntegrations({ platformDb, secretBox });
  const digests = platformDb && createDigests({ platformDb, getTenantDb, whatsapp, integrations });
  if (digests && scheduleDigests) digests.start();

  const app = express();
  app.set('trust proxy', trustProxy);

  app.use(cors());
  // Before the JSON parser: webhook signatures cover the raw body.
  app.use('/webhooks', createWebhookRouter({ platformDb, signingSecret: webhookSigningSecret, memberSync }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health Check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      project: 'Shenaly Rent a Car Operations API',
      database: platformDb ? (isConnected(platformDb) ? 'connected' : 'disconnected') : 'not_configured',
      timestamp: new Date()
    });
  });

  app.use('/api/platform', createPlatformRouter({ service, tenantUsers, integrations, platformAuth, platformDb }));
  app.use('/api/v1', createTenantRouter({ tenantAuth, platformDb, getTenantDb, directory: service, clerk, memberSync, storage, digests }));
  app.use('/api/public/:slug', createPublicRouter({ platformDb, getTenantDb, directory: service, storage }));

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
