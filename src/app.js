const express = require('express');
const cors = require('cors');
const { createPlatformRouter } = require('./routes/platform');
const { createPlatformService } = require('./platform/service');
const { seedDemoTenants } = require('./platform/seed');
const { PlatformError } = require('./platform/errors');

/**
 * Builds the Express app. `platformAuth` guards /api/platform (Clerk in
 * server.js, a stub in tests); `service` defaults to the seeded in-memory store.
 */
function createApp({ platformAuth, service = createPlatformService({ seed: seedDemoTenants }) }) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', project: 'Shenaly Rent a Car Operations API', timestamp: new Date() });
  });

  app.use('/api/platform', createPlatformRouter({ service, platformAuth }));

  // Placeholder for tenant API routers (Phase 1+)
  // app.use('/api/v1/vehicles', require('./routes/vehicleRoutes'));
  // app.use('/api/v1/renters', require('./routes/renterRoutes'));
  // app.use('/api/v1/rentals', require('./routes/rentalRoutes'));
  // app.use('/api/v1/costs', require('./routes/costRoutes'));
  // app.use('/api/v1/payments', require('./routes/paymentRoutes'));
  // app.use('/api/v1/whatsapp', require('./routes/whatsappRoutes'));

  // Error handler middleware
  app.use((err, req, res, next) => {
    if (err instanceof PlatformError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, issues: err.issues } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    console.error(err.stack);
    res.status(err.status || 500).json({ error: { code: 'internal', message: 'Internal Server Error' } });
  });

  return app;
}

module.exports = { createApp };
