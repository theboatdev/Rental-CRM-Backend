const express = require('express');
const cors = require('cors');
const { createPlatformRouter } = require('./routes/platform');
const { createTenantRouter } = require('./routes/tenant');
const { createPlatformService } = require('./platform/service');
const { seedDemoTenants } = require('./platform/seed');
const { errorHandler } = require('./middleware/errorHandler');
const { isConnected } = require('./db/platform');

/**
 * Builds the Express app.
 * - `platformAuth` guards /api/platform and `tenantAuth` starts the /api/v1
 *   chain (Clerk in server.js, stubs in tests).
 * - `platformDb` is the platform connection; tenant DBs are reached through it.
 *   Without it, /api/v1 responds 503.
 * - `service` defaults to the seeded in-memory store. It also resolves tenants
 *   for /api/v1, so both APIs see the same tenants.
 */
function createApp({ platformAuth, tenantAuth, platformDb, service = createPlatformService({ seed: seedDemoTenants }) }) {
  const app = express();

  app.use(cors());
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

  app.use('/api/platform', createPlatformRouter({ service, platformAuth }));
  app.use('/api/v1', createTenantRouter({ tenantAuth, platformDb, directory: service }));

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
