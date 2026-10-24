const express = require('express');
const cors = require('cors');
const { createPlatformRouter } = require('./routes/platform');
const { createTenantRouter } = require('./routes/tenant');
const { createWebhookRouter } = require('./routes/webhooks');
const { createPlatformService } = require('./platform/service');
const { createMemberSync } = require('./platform/members');
const { createTenantUsers } = require('./platform/tenantUsers');
const { createTenantDbGetter } = require('./db/tenantDb');
const { errorHandler } = require('./middleware/errorHandler');
const { createTenantAuth } = require('./middleware/tenantAuth');
const { isConnected } = require('./db/platform');

/**
 * Builds the Express app.
 * - `platformAuth` guards /api/platform and `tenantAuth` starts the /api/v1
 *   chain (Clerk in server.js, stubs in tests).
 * - `platformDb` is the platform connection; tenant DBs are reached through
 *   it. Without it, everything but /api/health and the platform rules responds 503.
 * - `clerk` is the Clerk gateway used by provisioning and the webhooks (a fake in tests).
 * - `webhookSigningSecret` verifies /webhooks/clerk.
 */
function createApp({ platformAuth, tenantAuth = createTenantAuth({}), platformDb, clerk, webhookSigningSecret }) {
  const getTenantDb = platformDb && createTenantDbGetter(platformDb);
  const service = platformDb && createPlatformService({ platformDb, getTenantDb, clerk });
  const memberSync = platformDb && createMemberSync({ platformDb, getTenantDb, clerk });
  const tenantUsers = platformDb && createTenantUsers({ platformDb, getTenantDb, clerk });

  const app = express();

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

  app.use('/api/platform', createPlatformRouter({ service, tenantUsers, platformAuth, platformDb }));
  app.use('/api/v1', createTenantRouter({ tenantAuth, platformDb, getTenantDb, directory: service, clerk, memberSync }));

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
